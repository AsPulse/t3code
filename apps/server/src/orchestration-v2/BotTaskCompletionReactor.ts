import {
  BOT_TASK_TAG,
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Notification,
  parseBotOwnerTag,
} from "@t3tools/contracts";
import { latestRootProviderFailure } from "@t3tools/shared/orchestrationV2ThreadError";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export class BotTaskCompletionReactor extends Context.Service<
  BotTaskCompletionReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/BotTaskCompletionReactor") {}

function excerpt(text: string | undefined): string {
  if (text === undefined) return "";
  const characters = Array.from(text.trim());
  if (characters.length === 0) return "";
  return `\n\n${characters.length > 600 ? `${characters.slice(0, 599).join("")}…` : characters.join("")}`;
}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;

  const handle: BotTaskCompletionReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (event.type === "run.updated") {
        if (event.payload.status !== "completed" && event.payload.status !== "failed") return;
      } else if (
        event.type !== "runtime-request.updated" ||
        event.payload.status !== "pending" ||
        event.payload.responseCapability.type !== "live"
      ) {
        return;
      }

      const task = yield* projections.findThread(event.threadId);
      if (task === null || task.deletedAt !== null || !task.tags?.includes(BOT_TASK_TAG)) return;
      const ownerId = task.tags.map(parseBotOwnerTag).find((id) => id !== null);
      if (ownerId === undefined || ownerId === task.id) return;
      const owner = yield* projections.findThread(ownerId);
      if (owner === null || owner.archivedAt !== null || owner.deletedAt !== null) return;

      const label = `Bot task "${task.title}"`;
      const environmentId = yield* environment.getEnvironmentId;
      const link = formatThreadLink({ environmentId, threadId: task.id }, task.title);
      let key: string;
      let text: string;
      let summary: string;
      let outcome: OrchestrationV2Notification["outcome"];
      if (event.type === "run.updated") {
        const run = event.payload;
        const completed = run.status === "completed";
        let detail: string | undefined;
        if (completed) {
          const { messages } = yield* projections.getThreadRecords(task.id, ["messages"], {
            messageRoles: ["assistant"],
            messageRunIds: [run.id],
          });
          detail = messages.at(-1)?.text;
        } else {
          const { turnItems } = yield* projections.getThreadRecords(task.id, ["turnItems"], {
            turnItemRunId: run.id,
            turnItemTypes: ["error"],
          });
          detail = latestRootProviderFailure(run, turnItems)?.message;
        }
        key = `bot-task-run:${task.id}:${run.id}`;
        outcome = completed ? "completed" : "failed";
        summary = `${label} ${outcome}`;
        text = `${summary}. ${link}${excerpt(detail)}\n\nRead it with t3_thread_read, threadId ${task.id}.`;
      } else {
        const request = yield* projections.getRuntimeRequest(task.id, event.payload.id);
        if (request?.status !== "pending") return;
        key = `bot-task-request:${task.id}:${request.id}`;
        outcome = "updated";
        summary = `${label} is waiting on a ${request.kind === "user_input" ? "question" : "approval"}`;
        text = `${summary} and cannot continue until it is answered. ${link} Read it with t3_pending_request action read, threadId ${task.id}, and requestId ${request.id}. Answer it with action respond when the answer follows from the task or the user's instructions; otherwise ask the user, then answer it. If it is no longer pending, it was answered or dismissed.`;
      }

      yield* engine.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`server:${key}`),
        threadId: ownerId,
        messageId: MessageId.make(`message:${key}`),
        text,
        notification: { source: { kind: "system" }, outcome, summary, detail: text },
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Waking a Bot task owner failed", { threadId: event.threadId, cause }),
        ),
      ),
  );

  const start = Effect.fn("BotTaskCompletionReactor.start")(function* () {
    yield* forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Bot task event stream failed", { cause })),
      ),
    );
  });

  return BotTaskCompletionReactor.of({ start, handle });
});

export const layer = Layer.effect(BotTaskCompletionReactor, make);
