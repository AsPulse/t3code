import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { BotEntry, BotUpsertInput, EnvironmentId, ProjectId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { useGT } from "gt-react";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ImageIcon,
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { lazy, Suspense, useState } from "react";

import { readLocalApi } from "../../localApi";
import { resolveProjectDefaultProviderModelSelection } from "../../providerInstances";
import { readEnvironmentProviders } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { BotAvatar } from "../sidebar/sidebarBots";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const commands = serverEnvironment.bots;
const ProjectIconPickerDialog = lazy(() =>
  import("./ProjectIconPickerDialog").then(({ ProjectIconPickerDialog }) => ({
    default: ProjectIconPickerDialog,
  })),
);

export function BotWorkspaceSettings({
  environmentId,
  projectId,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}) {
  const gt = useGT();
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const canEdit = useAtomValue(commands.setWorkspace.permissionAtom(environmentId));
  const setWorkspace = useAtomCommand(commands.setWorkspace, { reportFailure: false });
  const upsert = useAtomCommand(commands.upsert, { reportFailure: false });
  const deleteBot = useAtomCommand(commands.delete, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [nameEditor, setNameEditor] = useState<{ bot?: BotEntry; name: string } | null>(null);
  const [iconEditor, setIconEditor] = useState<BotEntry | null>(null);
  const workspace = config?.settings.projectSettingsOverrides[projectId]?.botWorkspace;
  const bots = workspace?.bots.toSorted((left, right) => left.order - right.order) ?? [];
  const editable = config !== null && canEdit;
  const disabled = !editable || pending;

  const withPending = (operation: () => Promise<unknown>) => {
    setPending(true);
    return operation().finally(() => setPending(false));
  };

  const showFailure = (result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: gt("An error occurred."),
      description: error instanceof Error ? error.message : undefined,
    });
  };
  const save = async (patch: Omit<BotUpsertInput, "projectId">) => {
    const result = await upsert({ environmentId, input: { projectId, ...patch } });
    showFailure(result);
    return result;
  };

  const moveBot = async (index: number, offset: -1 | 1) => {
    const from = bots[index];
    const to = bots[index + offset];
    if (!from || !to) return;
    const reordered = [...bots];
    reordered[index] = to;
    reordered[index + offset] = from;
    for (const [order, bot] of reordered.entries()) {
      if (order !== bot.order && (await save({ botId: bot.id, order }))._tag !== "Success") break;
    }
  };

  const removeBot = async (bot: BotEntry) => {
    const api = readLocalApi();
    if (!api) return;
    const confirmed = await settlePromise(() =>
      api.dialogs.confirm(
        gt("Remove {name} from Bot Workspace? Its thread will be kept.", { name: bot.name }),
        {
          variant: "destructive",
        },
      ),
    );
    if (confirmed._tag === "Failure" || !confirmed.value) return;
    showFailure(await deleteBot({ environmentId, input: { projectId, botId: bot.id } }));
  };

  // The server has no provider fallback, so a project without a default model would refuse a new
  // bot that a new thread here could still start; send the model the composer would pick.
  const newBotModel = () => {
    const settings = config?.settings;
    if (!settings) return {};
    const modelSelection =
      resolveProjectSettings(settings, projectId).settings.defaultModelSelection ??
      resolveProjectDefaultProviderModelSelection(
        readEnvironmentProviders(environmentId) ?? [],
        settings,
        projectId,
      );
    return modelSelection ? { modelSelection } : {};
  };

  const submitName = async () => {
    if (nameEditor === null) return;
    const name = nameEditor.name.trim();
    if (name.length === 0) return;
    const result = await save(
      nameEditor.bot ? { botId: nameEditor.bot.id, name } : { name, ...newBotModel() },
    );
    if (result._tag === "Success") setNameEditor(null);
  };

  return (
    <SettingsSection title={gt("Bot Workspace")}>
      <SettingsRow
        title={gt("Use as Bot Workspace")}
        description={
          !editable ? gt("This connection cannot change Bot Workspace settings.") : undefined
        }
        control={
          <Switch
            aria-label={gt("Use as Bot Workspace")}
            checked={workspace?.enabled ?? false}
            disabled={disabled}
            onCheckedChange={(enabled) =>
              void withPending(async () => {
                showFailure(await setWorkspace({ environmentId, input: { projectId, enabled } }));
              })
            }
          />
        }
      />
      {workspace?.enabled ? (
        <>
          {bots.map((bot, index) => (
            <SettingsRow
              key={bot.id}
              title={
                <span className="flex min-w-0 items-center gap-2">
                  <BotAvatar bot={bot} environmentId={environmentId} />
                  <span className="truncate">{bot.name}</span>
                  {bot.role === "primary" ? (
                    <Badge>{gt("Primary", { $context: "bot role" })}</Badge>
                  ) : null}
                </span>
              }
              control={
                <div className="flex flex-wrap items-center gap-1">
                  {bot.role === "secondary" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={disabled}
                      onClick={() =>
                        void withPending(() => save({ botId: bot.id, role: "primary" }))
                      }
                    >
                      {gt("Make Primary")}
                    </Button>
                  ) : null}
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={disabled || index === 0}
                    aria-label={gt("Move {name} up", { name: bot.name })}
                    onClick={() => void withPending(() => moveBot(index, -1))}
                  >
                    <ArrowUpIcon />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={disabled || index === bots.length - 1}
                    aria-label={gt("Move {name} down", { name: bot.name })}
                    onClick={() => void withPending(() => moveBot(index, 1))}
                  >
                    <ArrowDownIcon />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={disabled}
                    aria-label={gt("Rename {name}", { name: bot.name })}
                    onClick={() => setNameEditor({ bot, name: bot.name })}
                  >
                    <PencilIcon />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={disabled}
                    aria-label={gt("Change icon for {name}", { name: bot.name })}
                    onClick={() => setIconEditor(bot)}
                  >
                    <ImageIcon />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={disabled}
                    aria-label={gt("Remove {name}", { name: bot.name })}
                    onClick={() => void withPending(() => removeBot(bot))}
                  >
                    <Trash2Icon />
                  </Button>
                </div>
              }
            />
          ))}
          <div className="px-3 py-2 sm:px-4">
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => setNameEditor({ name: "" })}
            >
              <PlusIcon />
              {gt("Add bot")}
            </Button>
          </div>
        </>
      ) : null}
      {nameEditor !== null ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setNameEditor(null);
          }}
        >
          <DialogPopup>
            <form
              className="flex min-h-0 flex-col"
              onSubmit={(event) => {
                event.preventDefault();
                if (!disabled) void withPending(submitName);
              }}
            >
              <DialogHeader>
                <DialogTitle>{nameEditor.bot ? gt("Rename bot") : gt("Add bot")}</DialogTitle>
              </DialogHeader>
              <DialogPanel>
                <Input
                  aria-label={gt("Bot name")}
                  maxLength={64}
                  value={nameEditor.name}
                  onChange={(event) =>
                    setNameEditor({ ...nameEditor, name: event.currentTarget.value })
                  }
                />
              </DialogPanel>
              <DialogFooter>
                <Button type="submit" disabled={disabled || nameEditor.name.trim().length === 0}>
                  {nameEditor.bot ? gt("Save") : gt("Add bot")}
                </Button>
              </DialogFooter>
            </form>
          </DialogPopup>
        </Dialog>
      ) : null}
      {iconEditor && editable ? (
        <Suspense fallback={null}>
          <ProjectIconPickerDialog
            current={iconEditor.icon ?? null}
            projectName={iconEditor.name}
            open
            onOpenChange={(open) => {
              if (!open) setIconEditor(null);
            }}
            onSelect={(icon) => void withPending(() => save({ botId: iconEditor.id, icon }))}
          />
        </Suspense>
      ) : null}
    </SettingsSection>
  );
}
