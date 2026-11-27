import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  buildBotWorkspaceIndex,
  type BotWorkspaceIndex,
} from "@t3tools/client-runtime/state/bot-workspace";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import type { BotEntry, EnvironmentId, ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { useGT } from "gt-react";
import { BotIcon } from "lucide-react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { resolveStorage } from "../../lib/storage";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { registerCommands } from "../../shortcuts/dispatcher";
import { useQuietThreadShell, useServerConfigs, useThreadShell } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { environmentPresentations } from "../../state/presentation";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useThreadSelectionStore } from "../../threadSelectionStore";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useUiStateStore } from "../../uiStateStore";
import { ProjectFavicon } from "../ProjectFavicon";
import { hasUnseenCompletion, resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../CommandPalette.logic";

type SidebarBotMode = "work" | "bots";
export const useSidebarBotMode = create<{ mode: SidebarBotMode }>()(
  persist<{ mode: SidebarBotMode }>(() => ({ mode: "work" }), {
    name: "t3code:sidebar-bot-mode",
    storage: createJSONStorage(() =>
      resolveStorage(typeof window === "undefined" ? undefined : window.localStorage),
    ),
  }),
);

export function setSidebarBotMode(mode: SidebarBotMode) {
  if (useSidebarBotMode.getState().mode === mode) return;
  useThreadSelectionStore.getState().clearSelection();
  useSidebarBotMode.setState({ mode });
}

function toggleSidebarBotMode() {
  setSidebarBotMode(useSidebarBotMode.getState().mode === "work" ? "bots" : "work");
}

export function openBotWorkspaceSettings(
  router: AnyRouter,
  groups: readonly SidebarProjectSnapshot[],
  { environmentId, projectId }: BotWorkspaceIndex["workspaces"][number],
  onOpen: () => void,
) {
  for (const group of groups) {
    const member = group.memberProjects.find(
      (project) => project.environmentId === environmentId && project.id === projectId,
    );
    if (!member) continue;
    onOpen();
    return router.navigate({
      to: "/settings/projects",
      search: {
        project: group.projectKey,
        machine: environmentId,
        checkout: member.physicalProjectKey,
      },
    });
  }
}

function indexFromConfigs(
  configs: ReadonlyMap<EnvironmentId, EnvironmentServerConfig>,
  primary: EnvironmentId | null,
) {
  return buildBotWorkspaceIndex(
    Array.from(configs, ([environmentId, config]) => ({
      environmentId,
      projectSettingsOverrides: config.settings.projectSettingsOverrides,
    })),
    primary,
  );
}

const botWorkspaceIndexAtom = Atom.make((get) =>
  indexFromConfigs(get(environmentPresentations.serverConfigsAtom), get(primaryEnvironmentIdAtom)),
).pipe(Atom.withLabel("web-bot-workspace-index"));

export function unfolderedBotFilteredThreads(
  threads: readonly EnvironmentThreadShell[],
  groups: readonly {
    readonly memberProjectRefs: readonly {
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId;
    }[];
  }[],
) {
  const folderProjects = new Set(
    groups.flatMap(({ memberProjectRefs }) =>
      memberProjectRefs.map(({ environmentId, projectId }) => `${environmentId}:${projectId}`),
    ),
  );
  return threads.filter(
    ({ environmentId, projectId }) => !folderProjects.has(`${environmentId}:${projectId}`),
  );
}

export function useBotWorkspaceIndex() {
  return indexFromConfigs(useServerConfigs(), usePrimaryEnvironmentId());
}

const botThreadRef = (primary: NonNullable<ReturnType<typeof useBotWorkspaceIndex>["primary"]>) =>
  scopeThreadRef(primary.environmentId, primary.bot.threadId);

function navigateToBot(router: AnyRouter, ref: ScopedThreadRef) {
  return router.navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
}

export function registerSidebarBotCommands(router: AnyRouter) {
  return registerCommands(
    {
      "bots.openPrimary": (event) => {
        const primary = appAtomRegistry.get(botWorkspaceIndexAtom).primary;
        if (primary === null) return false;
        event.preventDefault();
        void navigateToBot(router, botThreadRef(primary));
        return true;
      },
      "bots.toggle": (event) => {
        event.preventDefault();
        toggleSidebarBotMode();
      },
    },
    {
      when: (event) =>
        !(event.target instanceof Element && event.target.closest("[data-keybinding-capture]")) &&
        !isCommandPaletteOpen() &&
        !isModelPickerOpen() &&
        appAtomRegistry.get(botWorkspaceIndexAtom).workspaces.length > 0,
    },
  );
}

export function useBotCommandPaletteItems(router: AnyRouter): readonly CommandPaletteActionItem[] {
  const gt = useGT();
  const index = useBotWorkspaceIndex();
  if (index.workspaces.length === 0) return [];
  const primary = index.primary;
  const items: CommandPaletteActionItem[] = [
    {
      kind: "action",
      value: "action:bots-toggle-sidebar",
      title: gt("Toggle Bots sidebar"),
      searchTerms: ["bot", "sidebar", "work"],
      shortcutCommand: "bots.toggle",
      icon: <BotIcon className={ITEM_ICON_CLASS} />,
      run: async () => toggleSidebarBotMode(),
    },
  ];
  if (primary !== null) {
    items.unshift({
      kind: "action",
      value: "action:bots-open-primary",
      title: gt("Open Primary Bot"),
      searchTerms: ["bot", "primary"],
      shortcutCommand: "bots.openPrimary",
      icon: <BotIcon className={ITEM_ICON_CLASS} />,
      run: () => navigateToBot(router, botThreadRef(primary)),
    });
  }
  return items;
}

export function BotAvatar({
  bot,
  environmentId,
}: {
  readonly bot: Pick<BotEntry, "icon" | "name">;
  readonly environmentId: ScopedThreadRef["environmentId"];
}) {
  return bot.icon === undefined ? (
    <BotIcon className="size-4 shrink-0" aria-hidden />
  ) : (
    <ProjectFavicon
      className="size-4 shrink-0"
      project={{
        environmentId,
        workspaceRoot: "",
        title: bot.name,
        faviconPath: null,
        projectIcon: bot.icon,
      }}
    />
  );
}

export function useBotThreadStatus(ref: ScopedThreadRef, live: boolean) {
  const liveThread = useThreadShell(live ? ref : null);
  const quietThread = useQuietThreadShell(live ? null : ref);
  const thread = liveThread ?? quietThread;
  const key = scopedThreadKey(ref);
  const localLastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[key]);
  return {
    working: thread !== null && isThreadWorking(thread),
    unread:
      thread !== null &&
      hasUnseenCompletion({
        ...thread,
        lastVisitedAt: resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt),
      }),
    preview: liveThread?.source.latestVisibleMessage?.text.replace(/\s+/g, " ").trim(),
  };
}
