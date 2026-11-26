import {
  BotId,
  BotRegistryError,
  CommandId,
  ProjectId,
  ThreadId,
  type BotDeleteInput,
  type BotEntry,
  type BotUpsertInput,
  type BotWorkspaceResult,
  type BotWorkspaceSetInput,
  type BotWorkspaceSettings,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettingsService from "../serverSettings.ts";

export class BotRegistryService extends Context.Service<
  BotRegistryService,
  {
    readonly list: () => Effect.Effect<readonly BotWorkspaceResult[], BotRegistryError>;
    readonly setWorkspace: (
      input: BotWorkspaceSetInput,
    ) => Effect.Effect<BotWorkspaceResult, BotRegistryError>;
    readonly upsert: (
      input: BotUpsertInput,
      source?: "web" | "mcp",
    ) => Effect.Effect<BotWorkspaceResult, BotRegistryError>;
    readonly delete: (input: BotDeleteInput) => Effect.Effect<BotWorkspaceResult, BotRegistryError>;
  }
>()("t3/bot/BotRegistryService") {}

const emptyWorkspace: BotWorkspaceSettings = { enabled: false, bots: [] };
const settingsFailed = (cause: unknown) => new BotRegistryError({ code: "settings_failed", cause });
const threadFailed = (cause: unknown) =>
  new BotRegistryError({ code: "thread_operation_failed", cause });

const make = Effect.gen(function* () {
  const settings = yield* ServerSettingsService.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const random = yield* SecureRandom.SecureRandom;
  const writes = yield* Semaphore.make(1);
  const read = settings.getSettings.pipe(Effect.mapError(settingsFailed));

  const requireProject = Effect.fn("BotRegistryService.requireProject")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projects
      .getById(projectId)
      .pipe(
        Effect.mapError(
          (cause) => new BotRegistryError({ code: "project_read_failed", projectId, cause }),
        ),
      );
    if (Option.isNone(project)) {
      return yield* new BotRegistryError({ code: "project_not_found", projectId });
    }
    return project.value;
  });

  const save = Effect.fn("BotRegistryService.save")(function* (
    current: ServerSettings,
    projectId: ProjectId,
    botWorkspace: BotWorkspaceSettings,
    otherOverrides: NonNullable<ServerSettingsPatch["projectSettingsOverrides"]> = {},
  ) {
    const updated = yield* settings
      .updateSettings({
        projectSettingsOverrides: {
          ...otherOverrides,
          [projectId]: { ...current.projectSettingsOverrides[projectId], botWorkspace },
        },
      })
      .pipe(Effect.mapError(settingsFailed));
    return {
      projectId,
      ...(updated.projectSettingsOverrides[projectId]?.botWorkspace ?? botWorkspace),
    };
  });

  const list = Effect.fn("BotRegistryService.list")(function* () {
    const current = yield* read;
    return Object.entries(current.projectSettingsOverrides).flatMap(([projectId, entry]) =>
      entry.botWorkspace === undefined
        ? []
        : [{ projectId: ProjectId.make(projectId), ...entry.botWorkspace }],
    );
  });

  const setWorkspace = Effect.fn("BotRegistryService.setWorkspace")(function* ({
    projectId,
    enabled,
  }: BotWorkspaceSetInput) {
    yield* requireProject(projectId);
    const current = yield* read;
    const workspace = current.projectSettingsOverrides[projectId]?.botWorkspace ?? emptyWorkspace;
    const otherOverrides = enabled
      ? Object.fromEntries(
          Object.entries(current.projectSettingsOverrides).flatMap(([id, entry]) =>
            id !== projectId && entry.botWorkspace?.enabled
              ? [[id, { ...entry, botWorkspace: { ...entry.botWorkspace, enabled: false } }]]
              : [],
          ),
        )
      : {};
    return yield* save(current, projectId, { ...workspace, enabled }, otherOverrides);
  }, writes.withPermits(1));

  const upsert = Effect.fn("BotRegistryService.upsert")(function* (
    input: BotUpsertInput,
    source: "web" | "mcp" = "web",
  ) {
    const { projectId, botId } = input;
    const project = yield* requireProject(projectId);
    const current = yield* read;
    const workspace = current.projectSettingsOverrides[projectId]?.botWorkspace;
    if (!workspace?.enabled) {
      return yield* new BotRegistryError({ code: "workspace_disabled", projectId });
    }
    const previous = workspace.bots.find(({ id }) => id === botId);
    if (botId !== undefined && previous === undefined) {
      return yield* new BotRegistryError({ code: "bot_not_found", projectId });
    }
    const name = input.name ?? previous?.name;
    if (name === undefined) {
      return yield* new BotRegistryError({ code: "name_required", projectId });
    }
    const threadId = input.threadId ?? previous?.threadId;
    if (input.threadId !== undefined && input.threadId !== previous?.threadId) {
      const thread = yield* threads
        .getThreadShell(input.threadId)
        .pipe(Effect.mapError(threadFailed));
      if (thread === null || thread.deletedAt !== null) {
        return yield* new BotRegistryError({ code: "thread_not_found", projectId });
      }
      if (workspace.bots.some((bot) => bot.threadId === input.threadId)) {
        return yield* new BotRegistryError({ code: "thread_already_assigned", projectId });
      }
    }

    const icon = input.icon === undefined ? previous?.icon : input.icon;
    const modelSelection =
      input.modelSelection === undefined ? previous?.modelSelection : input.modelSelection;
    const contextRotation =
      input.contextRotation === undefined ? previous?.contextRotation : input.contextRotation;
    const role = input.role ?? previous?.role ?? "secondary";
    const order =
      input.order ??
      previous?.order ??
      workspace.bots.reduce((last, bot) => Math.max(last, bot.order), -1) + 1;
    const id = botId ?? BotId.make(yield* random.uuidV4());

    const createResidentThread = Effect.gen(function* () {
      const { settings: effective } = resolveProjectSettings(current, projectId, project);
      const selection =
        modelSelection ??
        resolveNewThreadModelSelection({
          defaultSelection: effective.defaultModelSelection,
          fallbackSelection: effective.fallbackModelSelection,
          providers: yield* providers.getProviders,
          settings: effective,
          projectId,
          now: DateTime.toEpochMillis(yield* DateTime.now),
        }).selection;
      if (selection === null) {
        return yield* new BotRegistryError({ code: "model_required", projectId });
      }
      const threadId = ThreadId.make(yield* random.uuidV4());
      yield* threads
        .dispatch({
          type: "thread.create",
          commandId: CommandId.make(yield* random.uuidV4()),
          threadId,
          projectId,
          title: name,
          modelSelection: selection,
          runtimeMode: effective.defaultRuntimeMode,
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: source === "mcp" ? "agent" : "user",
          creationSource: source,
        })
        .pipe(Effect.mapError(threadFailed));
      yield* threads
        .dispatch({
          type: "thread.auto-settle.set",
          commandId: CommandId.make(yield* random.uuidV4()),
          threadId,
          enabled: false,
        })
        .pipe(Effect.mapError(threadFailed));
      return threadId;
    });

    // A disconnected caller must not interrupt the writes after the thread commits.
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const entry: BotEntry = {
          id,
          name,
          role,
          threadId: threadId ?? (yield* createResidentThread),
          order,
          ...(icon == null ? {} : { icon }),
          ...(modelSelection == null ? {} : { modelSelection }),
          ...(contextRotation == null ? {} : { contextRotation }),
        };
        const bots = workspace.bots.map((bot): BotEntry => {
          if (bot.id === id) return entry;
          return role === "primary" && bot.role === "primary" ? { ...bot, role: "secondary" } : bot;
        });
        if (previous === undefined) bots.push(entry);
        return yield* save(current, projectId, { enabled: true, bots });
      }),
    );
  }, writes.withPermits(1));

  const deleteBot = Effect.fn("BotRegistryService.delete")(function* ({
    projectId,
    botId,
  }: BotDeleteInput) {
    yield* requireProject(projectId);
    const current = yield* read;
    const workspace = current.projectSettingsOverrides[projectId]?.botWorkspace;
    if (workspace === undefined || !workspace.bots.some(({ id }) => id === botId)) {
      return yield* new BotRegistryError({ code: "bot_not_found", projectId });
    }
    return yield* save(current, projectId, {
      ...workspace,
      bots: workspace.bots.filter(({ id }) => id !== botId),
    });
  }, writes.withPermits(1));

  return BotRegistryService.of({ list, setWorkspace, upsert, delete: deleteBot });
});

export const layer = Layer.effect(BotRegistryService, make);
