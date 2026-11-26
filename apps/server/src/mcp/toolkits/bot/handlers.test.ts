import { expect, it } from "@effect/vitest";
import {
  BotId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type RuntimeMode,
  type ProviderInteractionMode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as BotContextRotation from "../../../bot/BotContextRotationService.ts";
import * as BotRegistryTest from "../../../bot/BotRegistryService.testkit.ts";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as BotHandlers from "./handlers.ts";
import { BotToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:bots");
const callerId = ThreadId.make("thread:caller");
const { projectId } = BotRegistryTest;

const layer = (runtimeMode: RuntimeMode, interactionMode: ProviderInteractionMode) => {
  const layerCallerThreads = Layer.effect(
    ThreadManagement.ThreadManagementService,
    Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      return {
        ...threads,
        getThreadShell: (id) =>
          id === callerId
            ? Effect.succeed(liveThreadShell(id, { runtimeMode, interactionMode }))
            : threads.getThreadShell(id),
      } satisfies ThreadManagement.ThreadManagementService["Service"];
    }),
  ).pipe(Layer.provide(BotRegistryTest.layer));
  const layerRotation = Layer.effect(
    BotContextRotation.BotContextRotationService,
    Effect.gen(function* () {
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      return BotContextRotation.BotContextRotationService.of({
        start: () => Effect.void,
        rotateNow: () =>
          executor.withLock(
            callerId,
            Effect.succeed({
              threadId: callerId,
              status: "dispatched",
            }),
          ),
      });
    }),
  ).pipe(Layer.provide(ThreadCommandExecutor.layer));
  const invocation = Layer.succeed(McpInvocationContext.McpInvocationContext, {
    environmentId,
    requestNamespace: "provider:bots",
    thread: {
      threadId: callerId,
      providerSessionId: "provider:bots",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    capabilities: new Set(["orchestration" as const]),
    issuedAt: 0,
  });
  return McpToolAccess.HandlersLayer.layer(BotHandlers.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ThreadCommandExecutor.layer,
        invocation,
        Layer.mock(Environment.ServerEnvironment)({
          getDescriptor: Effect.succeed({
            environmentId,
            label: "Test",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.0.0",
            capabilities: { repositoryIdentity: false },
          }),
        }),
        BotRegistryTest.layer,
        layerCallerThreads,
        layerRotation,
      ),
    ),
  );
};

it.effect("enables a workspace, creates a resident, lists it and removes its registration", () =>
  Effect.gen(function* () {
    const toolkit = yield* BotToolkit;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const set = yield* toolkit
      .handle("t3_bot_workspace_set", { projectId, enabled: true })
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(set.at(-1)?.result).toEqual({ projectId, enabled: true, bots: [] });

    const created = yield* toolkit
      .handle("t3_bot_upsert", { projectId, name: "MCP resident", role: "primary" })
      .pipe(Stream.unwrap, Stream.runCollect);
    const state = created.at(-1)?.result;
    if (!state || !("bots" in state) || !state.bots[0])
      return yield* Effect.die("Missing registered bot.");
    const resident = state.bots[0];
    expect(yield* threads.getThreadShell(resident.threadId)).toMatchObject({
      title: "MCP resident",
      projectId,
      creationSource: "mcp",
      createdBy: "agent",
    });

    const listed = yield* toolkit.handle("t3_bot_list", {}).pipe(Stream.unwrap, Stream.runCollect);
    expect(listed.at(-1)?.result).toEqual({ workspaces: [state] });
    const deleted = yield* toolkit
      .handle("t3_bot_delete", { projectId, botId: resident.id })
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(deleted.at(-1)?.result).toEqual({ projectId, enabled: true, bots: [] });
  }).pipe(Effect.provide(layer("full-access", "default"))),
);

it.effect.each([
  { runtimeMode: "full-access", interactionMode: "plan" },
  { runtimeMode: "approval-required", interactionMode: "default" },
] satisfies ReadonlyArray<{ runtimeMode: RuntimeMode; interactionMode: ProviderInteractionMode }>)(
  "denies registry mutations in $runtimeMode / $interactionMode",
  ({ runtimeMode, interactionMode }) =>
    Effect.gen(function* () {
      const toolkit = yield* BotToolkit;
      const set = yield* toolkit
        .handle("t3_bot_workspace_set", { projectId, enabled: true })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(set.at(-1)?.result).toMatchObject({ code: "capability_denied" });
      const upsert = yield* toolkit
        .handle("t3_bot_upsert", { projectId, name: "Denied" })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(upsert.at(-1)?.result).toMatchObject({ code: "capability_denied" });
      const rotate = yield* toolkit
        .handle("t3_bot_rotate_now", { projectId, botId: BotId.make("resident") })
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(rotate.at(-1)?.result).toMatchObject({ code: "capability_denied" });
      const listed = yield* toolkit
        .handle("t3_bot_list", {})
        .pipe(Stream.unwrap, Stream.runCollect);
      expect(listed.at(-1)?.result).toEqual({ workspaces: [] });
    }).pipe(Effect.provide(layer(runtimeMode, interactionMode))),
);

it.effect("lets a bot request rotation on its own thread without reacquiring its caller lock", () =>
  Effect.gen(function* () {
    const toolkit = yield* BotToolkit;
    const rotated = yield* toolkit
      .handle("t3_bot_rotate_now", { projectId, botId: BotId.make("resident") })
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(rotated.at(-1)?.result).toEqual({ threadId: callerId, status: "dispatched" });
  }).pipe(Effect.provide(layer("full-access", "default"))),
);
