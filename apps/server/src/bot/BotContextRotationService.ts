import {
  botForThread,
  BotRegistryError,
  CommandId,
  MessageId,
  type BotRotateNowInput,
  type BotRotateNowResult,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { isActiveRun } from "../orchestration-v2/CommandPolicy.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { idleRotationRun, readRotationHandoff } from "./BotContextRotation.ts";

export class BotContextRotationService extends Context.Service<
  BotContextRotationService,
  {
    readonly rotateNow: (
      input: BotRotateNowInput,
    ) => Effect.Effect<BotRotateNowResult, BotRegistryError>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/bot/BotContextRotationService") {}

// Flush before the two-minute idle compaction window opens.
const CACHE_LEAD_MS = 3 * 60_000;

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;

  const dispatchFlush = Effect.fn("BotContextRotationService.dispatchFlush")(function* (
    threadId: ThreadId,
    key: string,
    text: string,
    mode: "start_immediately" | "queue_after_active",
  ) {
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`server:bot-rotation:${key}`),
      messageId: MessageId.make(`bot-rotation:${key}`),
      threadId,
      text,
      attachments: [],
      createdBy: "agent",
      creationSource: "server",
      maintenance: "bot_context_rotation",
      dispatchMode: { type: mode },
    });
  });

  const rotateWhenDue = Effect.fn("BotContextRotationService.rotateWhenDue")(
    function* (threadId: ThreadId, completedRunId: RunId) {
      let runId = completedRunId;
      while (true) {
        const config = botForThread(yield* settings.getSettings, threadId)?.contextRotation;
        if (
          !config?.enabled ||
          (config.tokenThreshold === undefined && !config.rotateBeforeCacheExpires)
        )
          return;
        const thread = yield* projections.getThread(threadId);
        const activeProviderThreadIds =
          thread.activeProviderThreadId === null ? [] : [thread.activeProviderThreadId];
        const records = yield* projections.getThreadRecords(
          threadId,
          [
            "runs",
            "messages",
            "providerThreads",
            "runtimeRequests",
            "turnItems",
            "contextTransfers",
          ],
          {
            messageRunIds: [runId],
            messageRoles: ["user"],
            turnItemStatuses: ["pending", "running", "waiting"],
            runStatuses: ["queued", "preparing", "starting", "running", "waiting", "rolled_back"],
            includeLatestExecutedRun: true,
            providerThreadIds: activeProviderThreadIds,
            runtimeRequestStatuses: ["pending"],
            contextTransferStatuses: ["pending"],
          },
        );
        const latest = records.runs.findLast(
          (run) => run.status !== "cancelled" || run.startedAt !== null,
        );
        if (latest?.status === "completed" && latest.id !== runId) {
          runId = latest.id;
          continue;
        }
        const run = idleRotationRun(records, runId);
        if (
          run === null ||
          run.activeAttemptId === null ||
          records.runs.some(isActiveRun) ||
          run.providerThreadId !== records.thread.activeProviderThreadId
        )
          return;
        const { providerTurns } = yield* projections.getThreadRecords(threadId, ["providerTurns"], {
          providerTurnAttemptIds: [run.activeAttemptId],
          providerTurnThreadIds: activeProviderThreadIds,
        });
        const usage = providerTurns.findLast((turn) => turn.nodeId === run.rootNodeId)?.tokenUsage;
        if (usage === undefined) return;

        if (config.tokenThreshold === undefined || usage.usedTokens < config.tokenThreshold) {
          if (!config.rotateBeforeCacheExpires || usage.promptCacheExpiresAt === undefined) return;
          const remaining =
            Date.parse(usage.promptCacheExpiresAt) - DateTime.toEpochMillis(yield* DateTime.now);
          if (remaining <= 0) return;
          if (remaining > CACHE_LEAD_MS) {
            yield* Effect.sleep(remaining - CACHE_LEAD_MS);
            continue;
          }
        }
        yield* dispatchFlush(
          threadId,
          `${threadId}:${runId}`,
          config.flushPrompt,
          "start_immediately",
        );
        return;
      }
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Bot context rotation skipped", { threadId, cause }),
        ),
      ),
  );

  const rotateNow = Effect.fn("BotContextRotationService.rotateNow")(function* ({
    projectId,
    botId,
  }: BotRotateNowInput) {
    const current = yield* settings.getSettings.pipe(
      Effect.mapError(
        (cause) => new BotRegistryError({ code: "settings_failed", projectId, cause }),
      ),
    );
    const workspace = current.projectSettingsOverrides[projectId]?.botWorkspace;
    if (!workspace?.enabled) {
      return yield* new BotRegistryError({ code: "workspace_disabled", projectId });
    }
    const bot = workspace.bots.find((bot) => bot.id === botId);
    if (bot === undefined) return yield* new BotRegistryError({ code: "bot_not_found", projectId });
    const { threadId, contextRotation } = bot;
    if (!contextRotation?.enabled) {
      return yield* new BotRegistryError({ code: "rotation_disabled", projectId });
    }

    const threadError = (cause: unknown) =>
      new BotRegistryError({ code: "thread_operation_failed", projectId, cause });
    const { thread, runs } = yield* projections
      .getThreadRecords(threadId, ["runs"])
      .pipe(Effect.mapError(threadError));
    const latest = runs.at(-1);
    const inFlight = runs.filter((run) => isActiveRun(run) || run.status === "queued");
    const inFlightPrompts = yield* projections
      .getMessagesById(
        threadId,
        inFlight.map((run) => run.userMessageId),
      )
      .pipe(Effect.mapError(threadError));
    if (
      [...inFlightPrompts.values()].some((message) => message.maintenance !== undefined) ||
      (yield* readRotationHandoff(projections, { thread, runs, messages: [] }, Infinity).pipe(
        Effect.mapError(threadError),
      )) !== null
    ) {
      return { threadId, status: "already_pending" } satisfies BotRotateNowResult;
    }

    yield* dispatchFlush(
      threadId,
      `manual:${threadId}:${latest?.id ?? "none"}`,
      contextRotation.flushPrompt,
      "queue_after_active",
    ).pipe(Effect.mapError(threadError));
    return { threadId, status: "dispatched" } satisfies BotRotateNowResult;
  });

  const start = Effect.fn("BotContextRotationService.start")(function* () {
    const timers = yield* FiberMap.make<ThreadId>();
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        event.type === "run.updated" && event.payload.status === "completed"
          ? FiberMap.run(timers, event.threadId, rotateWhenDue(event.threadId, event.payload.id))
          : Effect.void,
      ),
    );
  });

  return BotContextRotationService.of({ rotateNow, start });
});

export const layer = Layer.effect(BotContextRotationService, make);
