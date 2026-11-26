import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  BotId,
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
  type BotContextRotation,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderTurnTokenUsage,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Rotation from "./BotContextRotationService.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const threadId = ThreadId.make("rotation-thread");
const projectId = ProjectId.make("rotation-project");
const botId = BotId.make("rotation-bot");
const flushPrompt = "Write the thread's handoff.";
const bootstrapPrompt = "Read the handoff first.";
const summary = "The queue fix ships tomorrow.";
type Turn = ProviderAdapter.ProviderAdapterV2TurnInput;

const fixture = Effect.fn("BotContextRotationTest.fixture")(function* () {
  const cwd = yield* checkpointWorkspace("bot-rotation");
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const starts = yield* Queue.unbounded<Turn>();
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    driver,
    instanceId,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: Effect.fn("BotContextRotationTest.openSession")(function* ({ providerSessionId }) {
      const now = yield* DateTime.now;
      const startTurn = (turn: Turn) => Queue.offer(starts, turn).pipe(Effect.asVoid);
      return {
        driver,
        instanceId,
        providerSessionId,
        providerSession: {
          id: providerSessionId,
          driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd,
          model: modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
        events: Stream.fromQueue(events),
        ensureThread: ({ threadId, forceNewNativeThread }) =>
          Effect.succeed({
            id: ProviderThreadId.make(`provider:${threadId}`),
            driver,
            providerInstanceId: instanceId,
            providerSessionId,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: {
              driver,
              nativeId: forceNewNativeThread ? "fresh" : "original",
              strength: "strong",
            },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          }),
        resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
        startTurn,
        compactThread: startTurn,
        steerTurn: () => Effect.die("Unexpected steer into flush"),
        interruptTurn: () => Effect.die("Unexpected interrupt of flush"),
        respondToRuntimeRequest: () => Effect.void,
        readThreadSnapshot: () => Effect.die("Unexpected native history read"),
        rollbackThread: () => Effect.die("Unexpected rollback"),
        forkThread: () => Effect.die("Unexpected fork"),
      };
    }),
  };
  const layer = (
    databaseLayer: NonNullable<
      Parameters<typeof ProviderReplayHarness.layerWithRegistry>[2]
    >["databaseLayer"] = Sqlite.layerMemory,
  ) =>
    Rotation.layer.pipe(
      Layer.provideMerge(
        ProviderReplayHarness.layerWithRegistry(
          { name: "bot-rotation" },
          ProviderAdapterRegistry.layerFromAdapters([adapter]),
          { runEffectWorker: false, ...(databaseLayer === undefined ? {} : { databaseLayer }) },
        ),
      ),
    );

  const finish = Effect.fn("BotContextRotationTest.finish")(function* (
    turn: Turn,
    text: string,
    usage?: Omit<OrchestrationV2ProviderTurnTokenUsage, "updatedAt">,
    compact = false,
  ) {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const completed = yield* watch(
      (event) =>
        event.type === "run.updated" &&
        event.payload.id === turn.runId &&
        event.payload.status === "completed",
    );
    const waiting = yield* watch(
      (event) =>
        event.type === "run.updated" &&
        event.payload.id === turn.runId &&
        event.payload.status === "waiting",
    );
    const now = yield* DateTime.now;
    const providerThreadId = turn.providerThread.id;
    const providerTurnId = ProviderTurnId.make(`turn:${turn.attemptId}`);
    yield* Queue.offer(events, {
      type: "provider_turn.updated",
      driver,
      providerTurn: {
        id: providerTurnId,
        providerThreadId,
        nodeId: turn.rootNodeId,
        runAttemptId: turn.attemptId,
        nativeTurnRef: { driver, nativeId: providerTurnId, strength: "strong" },
        ordinal: turn.providerTurnOrdinal,
        status: "completed",
        startedAt: now,
        completedAt: now,
        ...(usage === undefined
          ? {}
          : { tokenUsage: { ...usage, updatedAt: DateTime.formatIso(now) } }),
      },
    });
    const item = {
      id: TurnItemId.make(`output:${turn.runId}`),
      threadId,
      runId: turn.runId,
      nodeId: turn.rootNodeId,
      providerThreadId,
      providerTurnId,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: turn.runOrdinal * 100 + 1,
      status: "completed",
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    } as const;
    const messageId = MessageId.make(item.id);
    if (!compact) {
      yield* Queue.offer(events, {
        type: "message.updated",
        driver,
        message: {
          id: messageId,
          threadId,
          runId: turn.runId,
          nodeId: turn.rootNodeId,
          createdBy: "agent",
          creationSource: "provider",
          role: "assistant",
          text,
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
    }
    yield* Queue.offer(events, {
      type: "turn_item.updated",
      driver,
      turnItem: compact
        ? { ...item, type: "compaction", driver }
        : { ...item, type: "assistant_message", messageId, text, streaming: false },
    });
    yield* Queue.offer(events, {
      type: "turn.terminal",
      driver,
      providerThreadId,
      providerTurnId,
      runOrdinal: turn.runOrdinal,
      status: "completed",
      failure: null,
      threadDisposition: "reusable",
    });
    yield* Fiber.join(waiting);
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    yield* worker.drain();
    yield* Fiber.join(completed);
    return yield* orchestrator.getThreadProjection(threadId);
  });

  const takeStart = Effect.fn("BotContextRotationTest.takeStart")(function* () {
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    yield* worker.drain();
    return yield* Queue.take(starts);
  });
  return { layer, finish, takeStart, cwd };
});

const watch = Effect.fn("BotContextRotationTest.watch")(function* (
  predicate: (event: OrchestrationV2DomainEvent) => boolean,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  return yield* orchestrator.streamDomainEvents.pipe(
    Stream.filter(predicate),
    Stream.take(1),
    Stream.runDrain,
    Effect.forkScoped({ startImmediately: true }),
  );
});

const configure = Effect.fn("BotContextRotationTest.configure")(function* (
  config: Partial<BotContextRotation> = {},
) {
  const settings = yield* ServerSettings.ServerSettingsService;
  yield* settings.updateSettings({
    projectSettingsOverrides: {
      [projectId]: {
        botWorkspace: {
          enabled: true,
          bots: [
            {
              id: botId,
              name: "Rotation bot",
              threadId,
              role: "primary",
              order: 0,
              contextRotation: { enabled: true, flushPrompt, bootstrapPrompt, ...config },
            },
          ],
        },
      },
    },
  });
});

const create = Effect.fn("BotContextRotationTest.create")(function* (cwd: string) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create"),
    threadId,
    projectId,
    title: "Rotation",
    createdBy: "user",
    creationSource: "web",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: cwd,
  });
});

const send = Effect.fn("BotContextRotationTest.send")(function* (
  text: string,
  extra: Partial<
    Pick<
      Extract<import("@t3tools/contracts").OrchestrationV2Command, { type: "message.dispatch" }>,
      "dispatchMode" | "scheduledTaskId" | "freshContext" | "maintenance"
    >
  > = {},
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const messageId = MessageId.make(text);
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`send:${text}`),
    messageId,
    threadId,
    text,
    attachments: [],
    createdBy: "user",
    creationSource: "web",
    dispatchMode: { type: "start_immediately" },
    ...extra,
  });
  return messageId;
});

const assertBootstrap = Effect.fn("BotContextRotationTest.assertBootstrap")(function* (
  turn: Turn,
  messageId: MessageId,
  text: string,
  flush: Turn,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projection = yield* orchestrator.getThreadProjection(threadId);
  assert.equal(turn.message.text, `${bootstrapPrompt}\n\n${summary}\n\nUser message:\n${text}`);
  assert.notEqual(turn.providerThread.id, flush.providerThread.id);
  assert.equal(projection.runs.find((run) => run.id === turn.runId)?.freshContext, true);
  assert.equal(projection.messages.find((message) => message.id === messageId)?.text, text);
  assert.include(
    projection.turnItems.find(
      (item) => item.type === "user_message" && item.messageId === messageId,
    ),
    { text, freshContext: true },
  );
});

const watchFlush = watch(
  (event) =>
    event.type === "message.updated" && event.payload.maintenance === "bot_context_rotation",
);

it.effect("rotates after a token threshold and starts a queued restart in a fresh context", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    yield* Effect.gen(function* () {
      const rotation = yield* Rotation.BotContextRotationService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* configure({ tokenThreshold: 100 });
      yield* create(test.cwd);
      yield* rotation.start();
      yield* send("First turn");
      const first = yield* test.takeStart();
      const flushDispatched = yield* watchFlush;
      yield* test.finish(first, "First answer", { usedTokens: 100 });
      yield* Fiber.join(flushDispatched);
      const flush = yield* test.takeStart();
      assert.equal(flush.message.text, flushPrompt);

      const nextText = "Continue the discussion";
      const next = yield* send(nextText, {
        dispatchMode: { type: "restart_active", targetRunId: flush.runId },
      });
      const queued = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(queued.runs.find((run) => run.userMessageId === next)?.status, "queued");

      const promoted = yield* watch(
        (event) =>
          event.type === "run.updated" &&
          event.payload.userMessageId === next &&
          event.payload.status === "starting",
      );
      yield* test.finish(flush, summary);
      yield* Fiber.join(promoted);
      const started = yield* test.takeStart();
      yield* assertBootstrap(started, next, nextText, flush);
    }).pipe(Effect.provide(test.layer()));
  }),
);

it.effect("flushes three minutes before the idle cache expires", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const rotation = yield* Rotation.BotContextRotationService;
      yield* configure({ rotateBeforeCacheExpires: true });
      yield* create(test.cwd);
      yield* rotation.start();
      yield* send("Use the cache");
      const first = yield* test.takeStart();
      const flushDispatched = yield* watchFlush;
      const expiresAt = DateTime.addDuration(yield* DateTime.now, "5 minutes");
      yield* test.finish(first, "Cached answer", {
        usedTokens: 12,
        promptCacheExpiresAt: DateTime.formatIso(expiresAt),
      });
      yield* TestClock.adjust("119 seconds");
      assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 1);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(flushDispatched);
      assert.equal((yield* test.takeStart()).message.text, flushPrompt);
    }).pipe(Effect.provide(test.layer()));
  }),
);

it.effect(
  "starts manual rotation on an idle thread and restores its handoff after reopening SQLite",
  () =>
    Effect.gen(function* () {
      const test = yield* fixture();
      const dbDir = yield* FileSystem.FileSystem.use((fs) =>
        fs.makeTempDirectoryScoped({ prefix: "t3-bot-rotation-sqlite-" }),
      ).pipe(Effect.provide(NodeServices.layer));
      const databaseLayer = Sqlite.layerFromPath(`${dbDir}/rotation.sqlite`).pipe(
        Layer.provide(NodeServices.layer),
      );
      const flush = yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const rotation = yield* Rotation.BotContextRotationService;
        yield* configure();
        yield* create(test.cwd);
        yield* send("Normal prompt");
        const first = yield* test.takeStart();
        yield* test.finish(first, "Normal answer");
        yield* orchestrator.dispatch({
          type: "thread.visit",
          commandId: CommandId.make("read-normal-answer"),
          threadId,
          visitedAt: DateTime.formatIso(yield* DateTime.now),
        });
        const before = yield* orchestrator.getThreadShell(threadId);
        assert.isNotNull(before);
        assert.equal(before.latestRunId, first.runId);
        assert.isNotNull(before.latestRunCompletedAt);
        assert.isTrue(
          before.lastVisitedAt != null &&
            before.latestRunCompletedAt != null &&
            !DateTime.isGreaterThan(before.latestRunCompletedAt, before.lastVisitedAt),
        );
        yield* TestClock.adjust("1 second");
        assert.deepEqual(yield* rotation.rotateNow({ projectId, botId }), {
          threadId,
          status: "dispatched",
        });
        const during = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(during.runs.at(-1)?.status, "starting");
        const flush = yield* test.takeStart();
        const completed = yield* test.finish(flush, summary);
        assert.deepEqual(yield* rotation.rotateNow({ projectId, botId }), {
          threadId,
          status: "already_pending",
        });
        const after = yield* orchestrator.getThreadShell(threadId);
        assert.isNotNull(after);
        assert.deepInclude(after, {
          latestRunId: before.latestRunId,
          latestVisibleMessage: before.latestVisibleMessage,
          latestRunCompletedAt: before.latestRunCompletedAt,
          lastVisitedAt: before.lastVisitedAt,
          latestUserAuthoredMessageAt: before.latestUserAuthoredMessageAt,
          latestUserMessageAt: before.latestUserMessageAt,
          activeRunId: null,
        });
        assert.deepInclude(ProjectionStore.threadShellFromProjection(completed), {
          latestRunId: before.latestRunId,
          latestVisibleMessage: before.latestVisibleMessage,
          latestRunCompletedAt: before.latestRunCompletedAt,
          lastVisitedAt: before.lastVisitedAt,
        });
        return flush;
      }).pipe(Effect.provide(test.layer(databaseLayer)));

      yield* Effect.gen(function* () {
        yield* configure();
        yield* TestClock.adjust("1 second");
        yield* send("/compact", {
          freshContext: true,
          scheduledTaskId: ScheduledTaskId.make("side"),
        });
        const scheduled = yield* test.takeStart();
        assert.notInclude(scheduled.message.text, summary);
        yield* test.finish(scheduled, "", undefined, true);
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const text = "After restart";
        const messageId = MessageId.make(text);
        const compact = yield* store.getThreadRecords(threadId, ["messages", "runs"], {
          sinceLastCompaction: { keepMessageId: messageId, keepRunIds: [] },
          messageRoles: ["user"],
        });
        assert.notInclude(
          compact.messages.map((message) => message.runId),
          flush.runId,
        );
        yield* send(text);
        yield* assertBootstrap(yield* test.takeStart(), messageId, text, flush);
      }).pipe(Effect.provide(test.layer(databaseLayer)));
    }),
);

it.effect("keeps a flush that follows a pending handoff in the flushed session", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* configure();
      yield* create(test.cwd);
      yield* send("Normal prompt");
      yield* test.finish(yield* test.takeStart(), "Normal answer");
      yield* send(flushPrompt, { maintenance: "bot_context_rotation" });
      const flush = yield* test.takeStart();
      yield* test.finish(flush, summary);

      const again = "Flush again";
      yield* send(again, { maintenance: "bot_context_rotation" });
      const second = yield* test.takeStart();
      assert.equal(second.message.text, again);
      assert.equal(second.providerThread.id, flush.providerThread.id);
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.notEqual(projection.runs.find((run) => run.id === second.runId)?.freshContext, true);
    }).pipe(Effect.provide(test.layer()));
  }),
);

it.effect("skips an automatic flush if its idle window closes before dispatch", () =>
  Effect.gen(function* () {
    const test = yield* fixture();
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      yield* create(test.cwd);
      yield* send("Active turn");
      const first = yield* test.takeStart();
      yield* send("Queued turn", { dispatchMode: { type: "queue_after_active" } });
      yield* send(flushPrompt, { maintenance: "bot_context_rotation" });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        projection.runs.map((run) => run.status),
        ["running", "queued"],
      );
      assert.equal(projection.runs[0]?.id, first.runId);
      assert.isFalse(projection.messages.some((message) => message.maintenance !== undefined));
    }).pipe(Effect.provide(test.layer()));
  }),
);
