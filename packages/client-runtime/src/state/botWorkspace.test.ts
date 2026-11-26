import {
  BotId,
  BOT_TASK_TAG,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type BotEntry,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { buildBotWorkspaceIndex, classifyThread, partitionThreads } from "./botWorkspace.ts";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const workspace = ProjectId.make("bots");
const ordinary = ProjectId.make("ordinary");
const primary: BotEntry = {
  id: BotId.make("primary"),
  name: "Build bot",
  role: "primary",
  threadId: ThreadId.make("primary"),
  order: 5,
};
const secondary: BotEntry = {
  id: BotId.make("secondary"),
  name: "Review bot",
  role: "secondary",
  threadId: ThreadId.make("secondary"),
  order: 1,
};

const overrides = (environmentId: EnvironmentId, bots: readonly BotEntry[], enabled = true) => ({
  environmentId,
  projectSettingsOverrides: { [workspace]: { botWorkspace: { enabled, bots } } },
});

it("keeps resident threads out of both lists and separates workspaces, tagged tasks and work", () => {
  const index = buildBotWorkspaceIndex([overrides(local, [primary, secondary])], local);
  const resident = { environmentId: local, projectId: workspace, id: primary.threadId };
  const second = { ...resident, id: secondary.threadId };
  const workspaceTask = { ...resident, id: ThreadId.make("workspace-task") };
  const tagged = {
    ...resident,
    id: ThreadId.make("tagged-task"),
    projectId: ordinary,
    tags: [BOT_TASK_TAG],
  };
  const unrelated = { ...resident, environmentId: remote, projectId: ordinary };
  expect(index.primary).toEqual({ environmentId: local, bot: primary });
  expect(index.workspaces[0]?.bots).toEqual([secondary, primary]);
  expect(
    [resident, second, workspaceTask, tagged, unrelated].map((thread) =>
      classifyThread(index, thread),
    ),
  ).toEqual(["bot", "bot", "bot-workspace", "bot-task", "work"]);
  expect(partitionThreads(index, [resident, second, workspaceTask, tagged, unrelated])).toEqual({
    work: [unrelated],
    botTasks: [workspaceTask, tagged],
  });
  const untagged = { ...tagged, tags: [] };
  expect(partitionThreads(index, [untagged])).toEqual({ work: [untagged], botTasks: [] });
});

it("uses primary environment role first, then other primary roles, then bot order", () => {
  const remotePrimary = { ...primary, threadId: ThreadId.make("remote-primary"), order: 0 };
  expect(
    buildBotWorkspaceIndex([overrides(remote, [remotePrimary]), overrides(local, [primary])], local)
      .primary?.bot,
  ).toBe(primary);
  expect(
    buildBotWorkspaceIndex(
      [overrides(local, [secondary]), overrides(remote, [remotePrimary])],
      local,
    ).primary?.bot,
  ).toBe(remotePrimary);
  const remoteSecondary: BotEntry = { ...remotePrimary, role: "secondary" };
  expect(
    buildBotWorkspaceIndex(
      [overrides(local, [secondary]), overrides(remote, [remoteSecondary])],
      local,
    ).primary?.bot,
  ).toBe(remoteSecondary);
  expect(buildBotWorkspaceIndex([overrides(local, [])], local).primary).toBeNull();
});

it("returns the same work array when workspaces are disabled", () => {
  const threads = [
    { environmentId: local, projectId: workspace, id: primary.threadId, tags: [BOT_TASK_TAG] },
  ];
  const index = buildBotWorkspaceIndex([overrides(local, [primary], false)], local);
  expect(partitionThreads(index, threads).work).toBe(threads);
  expect(partitionThreads(index, threads).botTasks).toEqual([]);
});
