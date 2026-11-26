import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { PositiveInt, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProjectIconOverride } from "./project.ts";
import type { ServerSettings } from "./settings.ts";

const BotName = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export const BotId = BotName.pipe(Schema.brand("BotId"));
export type BotId = typeof BotId.Type;

export const BotRole = Schema.Literals(["primary", "secondary"]);
export type BotRole = typeof BotRole.Type;

export const BOT_ROTATION_PROMPT_MAX_LENGTH = 16_384;
const RotationPrompt = Schema.String.check(Schema.isMaxLength(BOT_ROTATION_PROMPT_MAX_LENGTH));
export const BotContextRotation = Schema.Struct({
  enabled: Schema.Boolean,
  flushPrompt: RotationPrompt,
  bootstrapPrompt: RotationPrompt,
  tokenThreshold: Schema.optionalKey(PositiveInt),
  rotateBeforeCacheExpires: Schema.optionalKey(Schema.Boolean),
}).check(
  Schema.makeFilter(
    ({ enabled, flushPrompt }) =>
      !enabled || flushPrompt.trim() !== "" || "An enabled context rotation needs a flush prompt.",
  ),
);
export type BotContextRotation = typeof BotContextRotation.Type;

export const BotEntry = Schema.Struct({
  id: BotId,
  name: BotName,
  role: BotRole,
  threadId: ThreadId,
  icon: Schema.optionalKey(ProjectIconOverride),
  modelSelection: Schema.optionalKey(ModelSelection),
  contextRotation: Schema.optionalKey(BotContextRotation),
  order: Schema.Int,
});
export type BotEntry = typeof BotEntry.Type;

export const BotWorkspaceSettings = Schema.Struct({
  enabled: Schema.Boolean,
  bots: Schema.Array(BotEntry),
});
export type BotWorkspaceSettings = typeof BotWorkspaceSettings.Type;

export const BotWorkspaceSetInput = Schema.Struct({
  projectId: ProjectId,
  enabled: Schema.Boolean,
});
export type BotWorkspaceSetInput = typeof BotWorkspaceSetInput.Type;

export const BotUpsertInput = Schema.Struct({
  projectId: ProjectId,
  botId: Schema.optionalKey(BotId),
  name: Schema.optionalKey(BotName),
  role: Schema.optionalKey(BotRole),
  icon: Schema.optionalKey(Schema.NullOr(ProjectIconOverride)),
  modelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  contextRotation: Schema.optionalKey(Schema.NullOr(BotContextRotation)),
  order: Schema.optionalKey(Schema.Int),
  threadId: Schema.optionalKey(ThreadId),
});
export type BotUpsertInput = typeof BotUpsertInput.Type;

export const BotDeleteInput = Schema.Struct({
  projectId: ProjectId,
  botId: BotId,
});
export type BotDeleteInput = typeof BotDeleteInput.Type;

export const BotRotateNowInput = Schema.Struct({ projectId: ProjectId, botId: BotId });
export type BotRotateNowInput = typeof BotRotateNowInput.Type;

export const BotRotateNowResult = Schema.Struct({
  threadId: ThreadId,
  status: Schema.Literals(["dispatched", "already_pending"]),
});
export type BotRotateNowResult = typeof BotRotateNowResult.Type;

export const BotWorkspaceResult = Schema.Struct({
  projectId: ProjectId,
  ...BotWorkspaceSettings.fields,
});
export type BotWorkspaceResult = typeof BotWorkspaceResult.Type;

export class BotRegistryError extends Schema.TaggedError<BotRegistryError>()("BotRegistryError", {
  code: Schema.Literals([
    "project_not_found",
    "workspace_disabled",
    "bot_not_found",
    "rotation_disabled",
    "thread_not_found",
    "thread_already_assigned",
    "name_required",
    "model_required",
    "settings_failed",
    "project_read_failed",
    "thread_operation_failed",
  ]),
  projectId: Schema.optionalKey(ProjectId),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message() {
    switch (this.code) {
      case "project_not_found":
        return "The project was not found.";
      case "workspace_disabled":
        return "Enable Bot Workspace for the project first.";
      case "bot_not_found":
        return "The bot was not found.";
      case "rotation_disabled":
        return "Enable context rotation for the bot first.";
      case "thread_not_found":
        return "The thread was not found.";
      case "thread_already_assigned":
        return "The thread already belongs to a bot in this workspace.";
      case "name_required":
        return "A new bot needs a name.";
      case "model_required":
        return "Select a model or configure a default model for the project.";
      case "settings_failed":
        return "Could not read or write Bot Workspace settings.";
      case "project_read_failed":
        return "Could not read the project.";
      case "thread_operation_failed":
        return "Could not read or configure the bot thread.";
    }
  }
}

export function botForThread(settings: ServerSettings, threadId: ThreadId): BotEntry | undefined {
  for (const { botWorkspace } of Object.values(settings.projectSettingsOverrides)) {
    if (!botWorkspace?.enabled) continue;
    const bot = botWorkspace.bots.find((entry) => entry.threadId === threadId);
    if (bot !== undefined) return bot;
  }
}

export const BOT_TASK_TAG = "bot:task";
const BOT_OWNER_PREFIX = "bot:owner:";
const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

export const botOwnerTag = (threadId: ThreadId) => `${BOT_OWNER_PREFIX}${threadId}`;

export function parseBotOwnerTag(tag: string): ThreadId | null {
  if (!tag.startsWith(BOT_OWNER_PREFIX)) return null;
  const id = tag.slice(BOT_OWNER_PREFIX.length);
  if (id !== id.trim() || /[\p{Cc}]/u.test(id)) return null;
  return Option.getOrNull(decodeThreadId(id));
}
