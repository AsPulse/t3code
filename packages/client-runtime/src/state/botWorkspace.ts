import {
  BOT_TASK_TAG,
  ProjectId,
  type BotEntry,
  type EnvironmentId,
  type ServerSettings,
  type ThreadId,
} from "@t3tools/contracts";

interface BotWorkspace {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly bots: readonly BotEntry[];
}

interface EnvironmentOverrides {
  readonly environmentId: EnvironmentId;
  readonly projectSettingsOverrides: ServerSettings["projectSettingsOverrides"];
}

interface ScopedBot {
  readonly environmentId: EnvironmentId;
  readonly bot: BotEntry;
}

export interface BotWorkspaceIndex {
  readonly workspaces: readonly BotWorkspace[];
  readonly primary: ScopedBot | null;
  readonly primaryWorkspace: BotWorkspace | null;
  readonly projects: ReadonlyMap<EnvironmentId, ReadonlySet<ProjectId>>;
  readonly residents: ReadonlyMap<EnvironmentId, ReadonlySet<ThreadId>>;
}

const disabledIndex: BotWorkspaceIndex = {
  workspaces: [],
  primary: null,
  primaryWorkspace: null,
  projects: new Map(),
  residents: new Map(),
};

interface Thread {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly tags?: readonly string[];
}

export function buildBotWorkspaceIndex(
  environments: Iterable<EnvironmentOverrides>,
  primaryEnvironmentId: EnvironmentId | null,
): BotWorkspaceIndex {
  const workspaces: BotWorkspace[] = [];
  const projects = new Map<EnvironmentId, Set<ProjectId>>();
  const residents = new Map<EnvironmentId, Set<ThreadId>>();

  for (const { environmentId, projectSettingsOverrides } of environments) {
    for (const [id, entry] of Object.entries(projectSettingsOverrides)) {
      if (!entry.botWorkspace?.enabled) continue;
      const projectId = ProjectId.make(id);
      const bots = [...entry.botWorkspace.bots].sort((left, right) => left.order - right.order);
      workspaces.push({ environmentId, projectId, bots });
      const projectIds = projects.get(environmentId) ?? new Set<ProjectId>();
      projectIds.add(projectId);
      projects.set(environmentId, projectIds);
      const threadIds = residents.get(environmentId) ?? new Set<ThreadId>();
      for (const bot of bots) threadIds.add(bot.threadId);
      residents.set(environmentId, threadIds);
    }
  }

  if (workspaces.length === 0) return disabledIndex;
  const primaryWorkspace =
    workspaces.find(({ environmentId }) => environmentId === primaryEnvironmentId) ??
    workspaces[0] ??
    null;
  const bots = workspaces.flatMap(({ environmentId, bots }) =>
    bots.map((bot) => ({ environmentId, bot })),
  );
  const primary =
    bots.find(
      ({ environmentId, bot }) => environmentId === primaryEnvironmentId && bot.role === "primary",
    ) ??
    bots.find(({ bot }) => bot.role === "primary") ??
    bots.reduce<ScopedBot | null>(
      (first, candidate) =>
        first === null || candidate.bot.order < first.bot.order ? candidate : first,
      null,
    );
  return { workspaces, primary, primaryWorkspace, projects, residents };
}

export function classifyThread(index: BotWorkspaceIndex, thread: Thread) {
  if (index.workspaces.length === 0) return "work";
  if (index.residents.get(thread.environmentId)?.has(thread.id)) return "bot";
  if (index.projects.get(thread.environmentId)?.has(thread.projectId)) return "bot-workspace";
  return thread.tags?.includes(BOT_TASK_TAG) ? "bot-task" : "work";
}

const EMPTY_THREADS: readonly never[] = [];

export function partitionThreads<T extends Thread>(
  index: BotWorkspaceIndex,
  threads: readonly T[],
): { readonly work: readonly T[]; readonly botTasks: readonly T[] } {
  if (index.workspaces.length === 0) return { work: threads, botTasks: EMPTY_THREADS };
  const work: T[] = [];
  const botTasks: T[] = [];
  for (const thread of threads) {
    switch (classifyThread(index, thread)) {
      case "work":
        work.push(thread);
        break;
      case "bot-workspace":
      case "bot-task":
        botTasks.push(thread);
        break;
    }
  }
  return { work, botTasks };
}
