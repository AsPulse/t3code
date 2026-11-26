import { OrchestratorMcpFailure, type BotRegistryError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as BotRegistry from "../../../bot/BotRegistryService.ts";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { BotToolkit } from "./tools.ts";

const access = Effect.gen(function* () {
  const { scope } = yield* readCaller();
  const environment = yield* Environment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  if (descriptor.environmentId !== scope.environmentId) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential belongs to another environment.",
    });
  }
  return yield* BotRegistry.BotRegistryService;
});

const failure = (error: BotRegistryError) =>
  new OrchestratorMcpFailure({
    code: error.cause === undefined ? "invalid_request" : "orchestration_error",
    message: error.message,
  });

const write = Effect.fn("BotToolkit.write")(function* <A, R>(
  check: Effect.Effect<unknown, OrchestratorMcpFailure, R>,
  operation: (
    bots: BotRegistry.BotRegistryService["Service"],
  ) => Effect.Effect<A, BotRegistryError>,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  // Recheck the caller's live run and modes after acquiring its thread lock.
  const update = check.pipe(
    Effect.andThen(access),
    Effect.flatMap((bots) => operation(bots).pipe(Effect.mapError(failure))),
  );
  return yield* scope.thread === undefined
    ? update
    : executor.withLock(scope.thread.threadId, update);
});

export const layer = McpToolAccess.toLayer(BotToolkit, {
  t3_bot_list: McpToolAccess.reads(() =>
    access.pipe(
      Effect.flatMap((bots) => bots.list().pipe(Effect.mapError(failure))),
      Effect.map((workspaces) => ({ workspaces })),
    ),
  ),
  t3_bot_workspace_set: McpToolAccess.writesEnvironment((input, check) =>
    write(check, (bots) => bots.setWorkspace(input)),
  ),
  t3_bot_upsert: McpToolAccess.writesEnvironment((input, check) =>
    write(check, (bots) => bots.upsert(input, "mcp")),
  ),
  t3_bot_delete: McpToolAccess.writesEnvironment((input, check) =>
    write(check, (bots) => bots.delete(input)),
  ),
});
