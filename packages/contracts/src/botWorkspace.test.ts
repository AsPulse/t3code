import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ThreadId, ProjectId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import {
  BotId,
  BotWorkspaceSettings,
  BOT_TASK_TAG,
  botOwnerTag,
  parseBotOwnerTag,
} from "./botWorkspace.ts";
import {
  DEFAULT_SERVER_SETTINGS,
  keepUnknownOverrideKeys,
  ProjectSettingsOverrides,
  ServerSettings,
} from "./settings.ts";

const encodeOverrides = Schema.encodeSync(ProjectSettingsOverrides);
const decodeOverrides = Schema.decodeSync(ProjectSettingsOverrides);
const encodeSettings = Schema.encodeSync(ServerSettings);
const decodeSettings = Schema.decodeSync(ServerSettings);
const keptOverrides = keepUnknownOverrideKeys(ProjectSettingsOverrides);
const encodeKeptOverrides = Schema.encodeSync(keptOverrides);
const decodeKeptOverrides = Schema.decodeSync(keptOverrides);

const projectId = ProjectId.make("project-bots");
const owner = ThreadId.make("thread-owner");
const botWorkspace: BotWorkspaceSettings = {
  enabled: true,
  bots: [
    {
      id: BotId.make("bot"),
      role: "primary",
      name: "Build bot",
      threadId: owner,
      icon: { kind: "emoji", emoji: "🤖" },
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      order: 0,
    },
  ],
};

describe("Bot Workspace settings", () => {
  it("round-trips the project override and the containing server settings", () => {
    const overrides = { botWorkspace, defaultAutoPull: true };
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      projectSettingsOverrides: { [projectId]: overrides },
    };
    expect(decodeOverrides(encodeOverrides(overrides))).toEqual(overrides);
    expect(decodeSettings(encodeSettings(settings)).projectSettingsOverrides).toEqual({
      [projectId]: overrides,
    });
  });

  it("round-trips unknown project override keys alongside the registry", () => {
    const stored = { botWorkspace, futureSetting: { enabled: true } };
    expect(encodeKeptOverrides(decodeKeptOverrides(stored))).toEqual(stored);
  });

  it("produces the reserved tags and reads only valid owner tags", () => {
    expect(BOT_TASK_TAG).toBe("bot:task");
    expect(botOwnerTag(owner)).toBe("bot:owner:thread-owner");
    expect(parseBotOwnerTag(botOwnerTag(owner))).toBe(owner);
    for (const tag of [
      "bot:task",
      "bot:owner:",
      "bot:owner: ",
      "bot:owner: padded",
      "bot:owner:new\nline",
      "BOT:owner:thread-owner",
    ]) {
      expect(parseBotOwnerTag(tag)).toBeNull();
    }
  });
});
