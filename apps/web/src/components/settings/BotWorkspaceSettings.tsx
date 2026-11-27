import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  BOT_ROTATION_PROMPT_MAX_LENGTH,
  type BotEntry,
  type BotUpsertInput,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
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
import { lazy, Suspense, useId, useState } from "react";

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
import { Label } from "../ui/label";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const commands = serverEnvironment.bots;

function editBot(bot?: BotEntry) {
  return {
    bot,
    name: bot?.name ?? "",
    enabled: bot?.contextRotation?.enabled ?? false,
    flushPrompt: bot?.contextRotation?.flushPrompt ?? "",
    bootstrapPrompt: bot?.contextRotation?.bootstrapPrompt ?? "",
    tokenThreshold: bot?.contextRotation?.tokenThreshold?.toString() ?? "",
    rotateBeforeCacheExpires: bot?.contextRotation?.rotateBeforeCacheExpires ?? false,
  };
}
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
  const rotationId = useId();
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const canEdit = useAtomValue(commands.setWorkspace.permissionAtom(environmentId));
  const setWorkspace = useAtomCommand(commands.setWorkspace, { reportFailure: false });
  const upsert = useAtomCommand(commands.upsert, { reportFailure: false });
  const deleteBot = useAtomCommand(commands.delete, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [botEditor, setBotEditor] = useState<ReturnType<typeof editBot> | null>(null);
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

  const tokenThreshold = botEditor?.tokenThreshold ? Number(botEditor.tokenThreshold) : undefined;
  const canSave =
    botEditor !== null &&
    botEditor.name.trim() !== "" &&
    (!botEditor.enabled || botEditor.flushPrompt.trim() !== "") &&
    (tokenThreshold === undefined || (Number.isSafeInteger(tokenThreshold) && tokenThreshold > 0));

  const submitBot = async () => {
    if (!canSave) return;
    const { bot, name, enabled, flushPrompt, bootstrapPrompt, rotateBeforeCacheExpires } =
      botEditor;
    const hasRotation =
      bot?.contextRotation !== undefined ||
      enabled ||
      flushPrompt !== "" ||
      bootstrapPrompt !== "" ||
      rotateBeforeCacheExpires ||
      tokenThreshold !== undefined;
    const result = await save({
      name: name.trim(),
      ...(bot ? { botId: bot.id } : newBotModel()),
      ...(hasRotation
        ? {
            contextRotation: {
              enabled,
              flushPrompt,
              bootstrapPrompt,
              rotateBeforeCacheExpires,
              ...(tokenThreshold === undefined ? {} : { tokenThreshold }),
            },
          }
        : {}),
    });
    if (result._tag === "Success") setBotEditor(null);
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
                    aria-label={gt("Edit {name}", { name: bot.name })}
                    onClick={() => setBotEditor(editBot(bot))}
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
              onClick={() => setBotEditor(editBot())}
            >
              <PlusIcon />
              {gt("Add bot")}
            </Button>
          </div>
        </>
      ) : null}
      {botEditor !== null ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setBotEditor(null);
          }}
        >
          <DialogPopup>
            <form
              className="flex min-h-0 flex-col"
              onSubmit={(event) => {
                event.preventDefault();
                if (!disabled) void withPending(submitBot);
              }}
            >
              <DialogHeader>
                <DialogTitle>{botEditor.bot ? gt("Edit bot") : gt("Add bot")}</DialogTitle>
              </DialogHeader>
              <DialogPanel>
                <Input
                  aria-label={gt("Bot name")}
                  maxLength={64}
                  value={botEditor.name}
                  onChange={(event) =>
                    setBotEditor({ ...botEditor, name: event.currentTarget.value })
                  }
                />
                <fieldset className="mt-4 flex flex-col gap-3">
                  <div className="flex items-center justify-between gap-2">
                    <Label htmlFor={`${rotationId}-enabled`}>{gt("Context rotation")}</Label>
                    <Switch
                      id={`${rotationId}-enabled`}
                      checked={botEditor.enabled}
                      onCheckedChange={(enabled) => setBotEditor({ ...botEditor, enabled })}
                    />
                  </div>
                  {botEditor.enabled ? (
                    <>
                      <div className="flex flex-col gap-1">
                        <Label htmlFor={`${rotationId}-threshold`}>{gt("Token threshold")}</Label>
                        <Input
                          id={`${rotationId}-threshold`}
                          type="number"
                          min={1}
                          step={1}
                          value={botEditor.tokenThreshold}
                          onChange={(event) =>
                            setBotEditor({
                              ...botEditor,
                              tokenThreshold: event.currentTarget.value,
                            })
                          }
                        />
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <Label htmlFor={`${rotationId}-cache`}>
                          {gt("Rotate before the prompt cache expires")}
                        </Label>
                        <Switch
                          id={`${rotationId}-cache`}
                          checked={botEditor.rotateBeforeCacheExpires}
                          onCheckedChange={(rotateBeforeCacheExpires) =>
                            setBotEditor({ ...botEditor, rotateBeforeCacheExpires })
                          }
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <Label htmlFor={`${rotationId}-flush`}>{gt("Flush prompt")}</Label>
                        <Textarea
                          id={`${rotationId}-flush`}
                          required
                          maxLength={BOT_ROTATION_PROMPT_MAX_LENGTH}
                          value={botEditor.flushPrompt}
                          onChange={(event) =>
                            setBotEditor({ ...botEditor, flushPrompt: event.currentTarget.value })
                          }
                        />
                      </div>
                      <div className="flex flex-col gap-1">
                        <Label htmlFor={`${rotationId}-bootstrap`}>{gt("Bootstrap prompt")}</Label>
                        <Textarea
                          id={`${rotationId}-bootstrap`}
                          maxLength={BOT_ROTATION_PROMPT_MAX_LENGTH}
                          value={botEditor.bootstrapPrompt}
                          onChange={(event) =>
                            setBotEditor({
                              ...botEditor,
                              bootstrapPrompt: event.currentTarget.value,
                            })
                          }
                        />
                      </div>
                    </>
                  ) : null}
                </fieldset>
              </DialogPanel>
              <DialogFooter>
                <Button type="submit" disabled={disabled || !canSave}>
                  {botEditor.bot ? gt("Save") : gt("Add bot")}
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
