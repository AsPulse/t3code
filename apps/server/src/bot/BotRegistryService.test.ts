import { expect, it } from "@effect/vitest";
import { BotId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Settings from "../serverSettings.ts";
import * as Bots from "./BotRegistryService.ts";
import {
  layer,
  modelSelection,
  otherId,
  projectId,
  projectOverrides,
} from "./BotRegistryService.testkit.ts";

it.effect("keeps saved bots and other overrides while enabling only one workspace at a time", () =>
  Effect.gen(function* () {
    const bots = yield* Bots.BotRegistryService;
    const settings = yield* Settings.ServerSettingsService;
    yield* bots.setWorkspace({ projectId, enabled: true });
    const created = yield* bots.upsert({ projectId, name: "Resident" });
    yield* bots.setWorkspace({ projectId: otherId, enabled: true });
    expect(yield* bots.list()).toEqual([
      { ...created, enabled: false },
      { projectId: otherId, enabled: true, bots: [] },
    ]);
    expect((yield* settings.getSettings).projectSettingsOverrides[projectId]).toEqual({
      ...projectOverrides,
      botWorkspace: { enabled: false, bots: created.bots },
    });
    yield* Effect.all(
      [
        bots.setWorkspace({ projectId: otherId, enabled: true }),
        bots.setWorkspace({ projectId, enabled: true }),
      ],
      { concurrency: "unbounded" },
    );
    expect((yield* bots.list()).filter((workspace) => workspace.enabled)).toHaveLength(1);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "creating a Primary demotes the previous one and deletion leaves the resident thread untouched",
  () =>
    Effect.gen(function* () {
      const bots = yield* Bots.BotRegistryService;
      const threads = yield* ThreadManagement.ThreadManagementService;
      yield* bots.setWorkspace({ projectId, enabled: true });
      const first = (yield* bots.upsert({ projectId, name: "Build", role: "primary" })).bots[0]!;
      const updated = yield* bots.upsert({ projectId, name: "Review", role: "primary" });
      const resident = updated.bots.find((bot) => bot.role === "primary")!;
      expect(updated.bots.find(({ id }) => id === first.id)?.role).toBe("secondary");
      expect(resident.name).toBe("Review");
      const before = yield* threads.getThreadShell(resident.threadId);
      expect(before).toMatchObject({
        title: "Review",
        projectId,
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        deletedAt: null,
      });
      expect(before?.autoSettleDisabledAt).toBeDefined();
      expect(before?.autoSettleDisabledAt).not.toBeNull();
      const remaining = yield* bots.delete({ projectId, botId: resident.id });
      expect(remaining.bots.map(({ id }) => id)).toEqual([first.id]);
      expect(yield* threads.getThreadShell(resident.threadId)).toEqual(before);
    }).pipe(Effect.provide(layer)),
);

it.effect("rejects absent projects and bots and writes into disabled workspaces", () =>
  Effect.gen(function* () {
    const bots = yield* Bots.BotRegistryService;
    const absent = yield* bots
      .setWorkspace({ projectId: ProjectId.make("absent"), enabled: true })
      .pipe(Effect.result);
    const disabled = yield* bots.upsert({ projectId, name: "Resident" }).pipe(Effect.result);
    const unknown = yield* bots
      .delete({ projectId, botId: BotId.make("absent") })
      .pipe(Effect.result);
    expect(
      [absent, disabled, unknown].map((result) => Result.isFailure(result) && result.failure.code),
    ).toEqual(["project_not_found", "workspace_disabled", "bot_not_found"]);
  }).pipe(Effect.provide(layer)),
);
