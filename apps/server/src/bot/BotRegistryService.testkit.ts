import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type Project,
  type ProjectSettingsOverrides,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
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
export const residentProjectId = ProjectId.make("project:resident");
export const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
export const projectOverrides = {
  defaultRuntimeMode: "approval-required",
  defaultModelSelection: modelSelection,
  defaultAutoPull: true,
  futureSetting: { value: 42 },
} satisfies ProjectSettingsOverrides & { futureSetting: unknown };

const projects = [projectId, otherId, residentProjectId].map((id): Project => ({
  id,
  title: id,
  workspaceRoot: `/not-used/${id}`,
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
  ProviderAdapterRegistry.layerFromAdaptersEffect(
    ProviderAdapter.ProviderAdapterV2.pipe(
      Effect.map((adapter) => [adapter]),
      Effect.provide(
        Layer.mock(ProviderAdapter.ProviderAdapterV2)({
          instanceId: modelSelection.instanceId,
          driver: ProviderDriverKind.make("codex"),
          getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        }),
      ),
    ),
  ),
  { databaseLayer: Sqlite.layerMemory, runEffectWorker: false },
);
const threadLayer = ThreadManagement.layer.pipe(
  Layer.provideMerge(
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
