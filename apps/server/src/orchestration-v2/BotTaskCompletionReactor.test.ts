import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { vi } from "vite-plus/test";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as BotTaskCompletion from "./BotTaskCompletionReactor.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const ownerId = ThreadId.make("thread:bot");
const taskId = ThreadId.make("thread:task");
const projectId = ProjectId.make("project:bot-task");
const environmentId = EnvironmentId.make("test-environment");
const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
const link = "[Check the build](t3-thread://v2/test-environment/thread:task)";
const adapter = Layer.mock(ProviderAdapter.ProviderAdapterV2)({
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
});
const layerTest = BotTaskCompletion.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      ProviderReplayHarness.layerWithRegistry(
        { name: "bot-task-completion" },
        ProviderAdapterRegistry.layerFromAdaptersEffect(
          Effect.map(ProviderAdapter.ProviderAdapterV2, (value) => [value]).pipe(
            Effect.provide(adapter),
          ),
        ),
        { databaseLayer: Sqlite.layerMemory, runEffectWorker: false },
      ),
      ProjectionStore.layer.pipe(Layer.provide(Sqlite.layerMemory)),
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(environmentId),
      }),
    ),
  ),
);

const setup = Effect.fn("test.setupBotTask")(function* (selfOwned = false) {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const reactor = yield* BotTaskCompletion.BotTaskCompletionReactor;
  for (const threadId of [ownerId, taskId]) {
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId,
      title: threadId === ownerId ? "Bot" : "Check the build",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      ...(threadId === taskId
        ? { tags: ["bot:task", `bot:owner:${selfOwned ? taskId : ownerId}`] }
        : {}),
      createdBy: "agent",
      creationSource: "mcp",
      initialMessage: {
        messageId: MessageId.make(`prompt:${threadId}`),
        text: "Check build status",
        attachments: [],
      },
    });
  }
  const { runs } = yield* projections.getThreadRecords(taskId, ["runs"]);
  const run = runs[0];
  if (run?.rootNodeId == null || run.providerThreadId === null) {
    return yield* Effect.die("Missing the task's initial run.");
  }
  const { id: runId, rootNodeId: nodeId, providerThreadId, requestedAt: now } = run;
  const update = (status: "completed" | "failed", id = "run-finished") =>
    ({
      id: EventId.make(id),
      type: "run.updated",
      threadId: taskId,
      runId,
      occurredAt: now,
      payload: { ...run, status, completedAt: now },
    }) satisfies OrchestrationV2DomainEvent;
  const ownerRecords = projections.getThreadRecords(ownerId, ["runs", "messages"]);
  return {
    engine,
    projections,
    eventSink,
    reactor,
    ownerRecords,
    update,
    runId,
    nodeId,
    providerThreadId,
    now,
  };
});

it.effect.each(["completed", "failed"] as const)("wakes the owner when a run is %s", (status) =>
  Effect.gen(function* () {
    const { eventSink, reactor, ownerRecords, update, runId, nodeId, providerThreadId, now } =
      yield* setup();
    const detail = status === "completed" ? "Build is green. " : "The build failed. ";
    const longText = detail + "x".repeat(605);
    const detailEvent: OrchestrationV2DomainEvent =
      status === "completed"
        ? {
            id: EventId.make("assistant-reply"),
            type: "message.updated",
            threadId: taskId,
            occurredAt: now,
            payload: {
              id: MessageId.make("assistant-reply"),
              threadId: taskId,
              runId,
              nodeId,
              role: "assistant",
              text: longText,
              attachments: [],
              streaming: false,
              createdAt: now,
              updatedAt: now,
              createdBy: "agent",
              creationSource: "provider",
            },
          }
        : {
            id: EventId.make("provider-error"),
            type: "turn-item.updated",
            threadId: taskId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make("provider-error"),
              threadId: taskId,
              runId,
              nodeId,
              providerThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 2,
              status: "failed",
              title: "Build failed",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "error",
              failure: { class: "provider_error", message: longText, code: null, retryable: null },
            },
          };
    const finished = update(status);
    yield* eventSink.write({ events: [detailEvent, finished] });
    yield* reactor.handle(finished);

    const messageId = `message:bot-task-run:${taskId}:${runId}`;
    const { messages, runs } = yield* ownerRecords;
    expect(messages.filter((message) => message.creationSource === "server")).toEqual([
      expect.objectContaining({
        id: messageId,
        text: `Bot task "Check the build" ${status}. ${link}\n\n${longText.slice(0, 599)}…\n\nRead it with t3_thread_read, threadId ${taskId}.`,
        createdBy: "agent",
        notification: expect.objectContaining({ source: { kind: "system" }, outcome: status }),
      }),
    ]);
    expect(runs.filter((run) => run.userMessageId === messageId)).toEqual([
      expect.objectContaining({ status: "queued" }),
    ]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  { kind: "user_input", response: "live", resolved: false, expected: "question" },
  { kind: "command", response: "live", resolved: false, expected: "approval" },
  { kind: "user_input", response: "live", resolved: true, expected: null },
  { kind: "user_input", response: "message", resolved: false, expected: null },
] as const)("handles a $response $kind request (resolved=$resolved)", (test) =>
  Effect.gen(function* () {
    const { eventSink, reactor, ownerRecords, runId, nodeId, now } = yield* setup();
    const requestId = RuntimeRequestId.make("request:build");
    const request = {
      id: EventId.make("pending-request"),
      type: "runtime-request.updated",
      threadId: taskId,
      runId,
      occurredAt: now,
      payload: {
        id: requestId,
        nodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: test.kind,
        status: "pending",
        responseCapability:
          test.response === "live"
            ? { type: "live", providerSessionId: ProviderSessionId.make("session:task") }
            : { type: "message" },
        createdAt: now,
        resolvedAt: null,
      },
    } satisfies OrchestrationV2DomainEvent;
    yield* eventSink.write({ events: [request] });
    if (test.resolved) {
      yield* eventSink.write({
        events: [
          {
            ...request,
            id: EventId.make("resolved-request"),
            payload: { ...request.payload, status: "resolved", resolvedAt: now },
          },
        ],
      });
    }
    yield* reactor.handle(request);

    const messageId = `message:bot-task-request:${taskId}:${requestId}`;
    const { messages, runs } = yield* ownerRecords;
    expect(messages.filter((message) => message.creationSource === "server")).toEqual(
      test.expected === null
        ? []
        : [
            expect.objectContaining({
              id: messageId,
              text: expect.stringContaining(
                `is waiting on a ${test.expected} and cannot continue until it is answered. ${link} Read it with t3_pending_request action read, threadId ${taskId}, and requestId ${requestId}.`,
              ),
            }),
          ],
    );
    expect(runs.filter((run) => run.userMessageId === messageId)).toEqual(
      test.expected === null ? [] : [expect.objectContaining({ status: "queued" })],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("replays the wake command for another completion event with the same run ID", () =>
  Effect.gen(function* () {
    const { engine, eventSink, reactor, ownerRecords, update, runId } = yield* setup();
    const dispatch = engine.dispatch;
    const replays: boolean[] = [];
    using _dispatch = vi.spyOn(engine, "dispatch").mockImplementation((command) =>
      dispatch(command).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            replays.push(result.replayed === true);
          }),
        ),
      ),
    );
    const first = update("completed");
    yield* eventSink.write({ events: [first] });
    yield* reactor.handle(first);
    const beforeReplay = yield* ownerRecords;
    const commandId = CommandId.make(`server:bot-task-run:${taskId}:${runId}`);
    const readWakeEvents = eventSink.readByCommandId({ commandId }).pipe(Stream.runCollect);
    const firstWake = yield* readWakeEvents;
    expect(firstWake.filter(({ event }) => event.type === "run.created")).toHaveLength(1);

    const duplicate = update("completed", "duplicate-completion");
    yield* eventSink.write({ events: [duplicate] });
    yield* reactor.handle(duplicate);

    expect(replays).toEqual([false, true]);
    expect(yield* readWakeEvents).toEqual(firstWake);
    expect(yield* ownerRecords).toEqual(beforeReplay);
    expect(
      beforeReplay.messages.filter((message) => message.creationSource === "server"),
    ).toHaveLength(1);
    expect(beforeReplay.runs.filter((run) => run.status === "queued")).toHaveLength(1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["archived owner", "promoted task", "self-owned task"] as const)(
  "skips the completion of a task with %s",
  (reason) =>
    Effect.gen(function* () {
      const { engine, projections, eventSink, reactor, update } = yield* setup(
        reason === "self-owned task",
      );
      if (reason === "archived owner") {
        yield* engine.dispatch({
          type: "thread.archive",
          commandId: CommandId.make("archive-owner"),
          threadId: ownerId,
        });
      } else if (reason === "promoted task") {
        yield* engine.dispatch({
          type: "thread.tag.set",
          commandId: CommandId.make("promote-task"),
          threadId: taskId,
          tag: "bot:task",
          tagged: false,
        });
      }
      const completed = update("completed");
      yield* eventSink.write({ events: [completed] });
      yield* reactor.handle(completed);
      const targetId = reason === "self-owned task" ? taskId : ownerId;
      const { messages } = yield* projections.getThreadRecords(targetId, ["messages"]);
      expect(messages.filter((message) => message.creationSource === "server")).toEqual([]);
    }).pipe(Effect.provide(layerTest)),
);
