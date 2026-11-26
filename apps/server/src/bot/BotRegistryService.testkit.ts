import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  ProjectId,
  ProviderInstanceId,
  type Project,
  type ProjectSettingsOverrides,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Settings from "../serverSettings.ts";
import * as Bots from "./BotRegistryService.ts";

export const projectId = ProjectId.make("project:bots");
export const otherId = ProjectId.make("project:other");
export const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
export const projectOverrides = {
  defaultRuntimeMode: "approval-required",
  defaultModelSelection: modelSelection,
  defaultAutoPull: true,
  futureSetting: { value: 42 },
} satisfies ProjectSettingsOverrides & { futureSetting: unknown };

const projects = [projectId, otherId].map((id): Project => ({
  id,
  title: id,
  workspaceRoot: "/not-used",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
}));

const settingsLayer = Settings.layerTest({
  projectSettingsFolded: true,
  projectSettingsOverrides: { [projectId]: projectOverrides },
  defaultModelSelection: { ...modelSelection, model: "global-default" },
});

const orchestration = ProviderReplayHarness.layerWithRegistry(
  { name: "bot-registry" },
  ProviderAdapterRegistry.layerFromAdapters([]),
  { databaseLayer: Sqlite.layerMemory, runEffectWorker: false },
);
const threadLayer = ThreadManagement.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      orchestration,
      settingsLayer,
      CommandReceiptStore.layer.pipe(Layer.provide(Sqlite.layerMemory)),
    ),
  ),
);
export const layer = Bots.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      NodeCrypto.layer,
      settingsLayer,
      threadLayer,
      Layer.mock(ProjectService.ProjectService)({
        getById: (id) =>
          Effect.succeed(Option.fromUndefinedOr(projects.find((project) => project.id === id))),
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    ),
  ),
);
