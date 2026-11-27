import {
  BotDeleteInput,
  BotRotateNowInput,
  BotRotateNowResult,
  BotUpsertInput,
  BotWorkspaceResult,
  BotWorkspaceSetInput,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as BotContextRotation from "../../../bot/BotContextRotationService.ts";
import * as BotRegistry from "../../../bot/BotRegistryService.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    BotRegistry.BotRegistryService,
    McpInvocationContext.McpInvocationContext,
    ServerEnvironment.ServerEnvironment,
    ThreadCommandExecutor.ThreadCommandExecutor,
    ThreadManagementService.ThreadManagementService,
  ],
};
const target = { environmentId: OrchestratorMcpEnvironmentTarget };

export const BotToolkit = Toolkit.make(
  Tool.make("t3_bot_list", {
    ...shared,
    description: "List projects with Bot Workspace settings and their bots.",
    parameters: Schema.Struct(target),
    success: Schema.Struct({ workspaces: Schema.Array(BotWorkspaceResult) }),
  })
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false),
  Tool.make("t3_bot_workspace_set", {
    ...shared,
    description: "Enable or disable a Bot Workspace. Enabling disables the previous workspace.",
    parameters: Schema.Struct({ ...target, ...BotWorkspaceSetInput.fields }),
    success: BotWorkspaceResult,
  }).annotate(Tool.Destructive, true),
  Tool.make("t3_bot_upsert", {
    ...shared,
    description:
      "Add or edit a bot. New bots get a thread unless you assign one. Setting Primary demotes the previous Primary.",
    parameters: Schema.Struct({ ...target, ...BotUpsertInput.fields }),
    success: BotWorkspaceResult,
  }).annotate(Tool.Destructive, true),
  Tool.make("t3_bot_rotate_now", {
    ...shared,
    dependencies: [...shared.dependencies, BotContextRotation.BotContextRotationService],
    description: "Queue a context refresh for an enabled bot.",
    parameters: Schema.Struct({ ...target, ...BotRotateNowInput.fields }),
    success: BotRotateNowResult,
  }).annotate(Tool.Destructive, true),
  Tool.make("t3_bot_delete", {
    ...shared,
    description: "Remove a bot from its workspace and keep its thread.",
    parameters: Schema.Struct({ ...target, ...BotDeleteInput.fields }),
    success: BotWorkspaceResult,
  }).annotate(Tool.Destructive, true),
);
