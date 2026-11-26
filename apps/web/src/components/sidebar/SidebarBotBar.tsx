import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { BotWorkspaceIndex } from "@t3tools/client-runtime/state/bot-workspace";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import type { BotEntry, EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { PlusIcon } from "lucide-react";

import { useUiStateStore } from "../../uiStateStore";
import { hasUnseenCompletion, resolveThreadLastVisitedAt } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { SidebarGroup, SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { BotAvatar, useBotThreadStatus } from "./sidebarBots";

type Workspace = BotWorkspaceIndex["workspaces"][number];
type BotMode = "work" | "bots";
type OpenBot = (ref: ScopedThreadRef) => void;

function BotRow({
  bot,
  environmentId,
  onOpen,
  primary = false,
}: {
  readonly bot: BotEntry;
  readonly environmentId: EnvironmentId;
  readonly onOpen: OpenBot;
  readonly primary?: boolean;
}) {
  const gt = useGT();
  const ref = scopeThreadRef(environmentId, bot.threadId);
  const { working, unread, preview } = useBotThreadStatus(ref, primary);
  return (
    <SidebarMenuButton title={bot.name} onClick={() => onOpen(ref)}>
      <BotAvatar bot={bot} environmentId={environmentId} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate leading-4">{bot.name}</span>
        {preview ? (
          <span className="truncate text-xs leading-3 text-muted-foreground">{preview}</span>
        ) : null}
      </span>
      {working ? (
        <span
          className="size-2 shrink-0 rounded-full bg-info-foreground"
          role="img"
          aria-label={gt("Working", { $context: "thread status" })}
        />
      ) : null}
      {unread ? (
        <span
          className="size-2 shrink-0 rounded-full bg-primary"
          role="img"
          aria-label={gt("Unread")}
        />
      ) : null}
    </SidebarMenuButton>
  );
}

export function SidebarBotBar({
  index,
  mode,
  threads,
  botTasks,
  onModeChange,
  onOpenBot,
  onAddBot,
}: {
  readonly index: BotWorkspaceIndex;
  readonly mode: BotMode;
  readonly threads: readonly EnvironmentThreadShell[];
  readonly botTasks: readonly EnvironmentThreadShell[];
  readonly onModeChange: (mode: BotMode) => void;
  readonly onOpenBot: OpenBot;
  readonly onAddBot: (workspace: Workspace) => void;
}) {
  const gt = useGT();
  const primary = index.primary;
  const workspace = index.primaryWorkspace;
  const secondaryThreads = threads.filter(
    (thread) =>
      index.residents.get(thread.environmentId)?.has(thread.id) &&
      !(primary?.environmentId === thread.environmentId && primary.bot.threadId === thread.id),
  );
  const hasUnread = useUiStateStore((state) =>
    secondaryThreads.some((thread) => {
      const local =
        state.threadLastVisitedAtById[
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
        ];
      return hasUnseenCompletion({
        ...thread,
        lastVisitedAt: resolveThreadLastVisitedAt(thread.lastVisitedAt, local),
      });
    }),
  );
  const workingCount = botTasks.filter(
    (thread) => thread.archivedAt === null && isThreadWorking(thread),
  ).length;
  return (
    <div
      className="flex h-11 shrink-0 items-center gap-1 border-b px-2"
      aria-label={gt("Bot Workspace")}
    >
      <div className="min-w-0 flex-1">
        {primary ? (
          <BotRow
            bot={primary.bot}
            environmentId={primary.environmentId}
            onOpen={onOpenBot}
            primary
          />
        ) : workspace ? (
          <Button size="sm" variant="ghost" onClick={() => onAddBot(workspace)}>
            <PlusIcon />
            {gt("Add bot")}
          </Button>
        ) : null}
      </div>
      <ToggleGroup
        aria-label={gt("Sidebar mode")}
        value={[mode]}
        onValueChange={(value) => {
          if (value[0] === "work" || value[0] === "bots") onModeChange(value[0]);
        }}
      >
        <Toggle value="work">{gt("Work", { $context: "sidebar mode for coding threads" })}</Toggle>
        <Toggle value="bots">
          {gt("Bots")}
          {hasUnread ? (
            <span
              className="size-1.5 rounded-full bg-primary"
              role="img"
              aria-label={gt("Unread bots")}
            />
          ) : null}
          {workingCount > 0 ? (
            <span
              className="tabular-nums"
              aria-label={gt(
                "{count, plural, one {{count} working bot task} other {{count} working bot tasks}}",
                { count: workingCount },
              )}
            >
              {workingCount}
            </span>
          ) : null}
        </Toggle>
      </ToggleGroup>
    </div>
  );
}

export function SidebarSecondaryBots({
  index,
  onOpenBot,
}: {
  readonly index: BotWorkspaceIndex;
  readonly onOpenBot: OpenBot;
}) {
  const gt = useGT();
  const bots = index.workspaces.flatMap(({ environmentId, bots }) =>
    bots.flatMap((bot) =>
      index.primary?.environmentId === environmentId && index.primary.bot.id === bot.id
        ? []
        : [{ environmentId, bot }],
    ),
  );
  if (bots.length === 0) return null;
  return (
    <SidebarGroup>
      <h2 className="px-2 py-1 text-xs font-medium text-sidebar-muted-foreground">
        {gt("Secondary Bots")}
      </h2>
      <SidebarMenu>
        {bots.map(({ environmentId, bot }) => (
          <SidebarMenuItem key={scopedThreadKey(scopeThreadRef(environmentId, bot.threadId))}>
            <BotRow bot={bot} environmentId={environmentId} onOpen={onOpenBot} />
          </SidebarMenuItem>
        ))}
      </SidebarMenu>
    </SidebarGroup>
  );
}
