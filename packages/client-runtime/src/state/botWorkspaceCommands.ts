import { WS_METHODS, type EnvironmentId } from "@t3tools/contracts";
import type * as Atom from "effect/reactivity/Atom";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import { type AtomCommandScheduler, createEnvironmentRpcCommand } from "./runtime.ts";

export function createBotWorkspaceCommands<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
  scheduler: AtomCommandScheduler,
) {
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: EnvironmentId }) => environmentId,
  };
  return {
    setWorkspace: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bots:set-workspace",
      tag: WS_METHODS.botsSetWorkspace,
      scheduler,
      concurrency,
    }),
    upsert: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bots:upsert",
      tag: WS_METHODS.botsUpsert,
      scheduler,
      concurrency,
    }),
    delete: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:bots:delete",
      tag: WS_METHODS.botsDelete,
      scheduler,
      concurrency,
    }),
  };
}
