import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CLOUD_LINKED_USER_ID } from "../cloud/config.ts";
import * as ServerConfig from "../config.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { recordStartupHeartbeat } from "../serverRuntimeStartup.ts";
import * as AnalyticsService from "./AnalyticsService.ts";

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))(
  "startup telemetry identity",
  (it) => {
    it.effect.each(["env opt-out", "managed policy", "pending shell consent", "enabled"])(
      "accesses identity data only when enabled (%s)",
      (mode) =>
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = path.join(config.baseDir, "home");
          const codexPath = path.join(home, ".codex", "auth.json");
          const claudePath = path.join(home, ".claude.json");
          yield* fs.makeDirectory(path.dirname(codexPath), { recursive: true });
          yield* fs.writeFileString(codexPath, '{"tokens":{"account_id":"test-codex"}}');
          yield* fs.writeFileString(
            claudePath,
            '{"userID":"test-claude","oauthAccount":{"accountUuid":"test-owner"}}',
          );

          const reads = new Set<string>();
          const writes: string[] = [];
          const secretGets: string[] = [];
          const observedFs = FileSystem.FileSystem.of({
            ...fs,
            readFileString: (filePath, encoding) =>
              Effect.suspend(() => {
                reads.add(filePath);
                return fs.readFileString(filePath, encoding);
              }),
            rename: (from, to) =>
              Effect.suspend(() => {
                writes.push(to);
                return fs.rename(from, to);
              }),
          });
          const analyticsLayer = AnalyticsService.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                ConfigProvider.layer(
                  ConfigProvider.fromUnknown({ T3CODE_TELEMETRY_ENABLED: mode !== "env opt-out" }),
                ),
                ManagedPolicy.layerTest(
                  mode === "managed policy"
                    ? {
                        schemaVersion: 1,
                        organization: "Example Corp",
                        limits: { telemetry: false },
                      }
                    : undefined,
                ),
                Layer.succeed(
                  HttpClient.HttpClient,
                  HttpClient.make((request) =>
                    Effect.succeed(
                      HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })),
                    ),
                  ),
                ),
              ),
            ),
          );
          yield* recordStartupHeartbeat.pipe(
            Effect.provide(
              Layer.mergeAll(
                analyticsLayer,
                Layer.mock(ProjectService.ProjectService)({
                  snapshot: Effect.succeed({ projects: [], updatedAt: "2026-01-01T00:00:00.000Z" }),
                }),
                Layer.mock(ThreadManagement.ThreadManagementService)({
                  countThreads: () => Effect.succeed(0),
                }),
                Layer.mock(ServerSecretStore.ServerSecretStore)({
                  get: (key) =>
                    Effect.sync(() => {
                      secretGets.push(key);
                      return Option.none();
                    }),
                }),
              ),
            ),
            Effect.provideService(FileSystem.FileSystem, observedFs),
            Effect.provideService(HostProcess.HomeDirectory, home),
            Effect.provideService(
              HostProcess.Environment,
              mode === "pending shell consent"
                ? { T3CODE_DESKTOP_SHELL_DISCOVERY_PENDING: "1" }
                : {},
            ),
          );

          const enabled = mode === "enabled";
          assert.deepEqual(
            { reads, writes, secretGets },
            {
              reads: new Set(enabled ? [codexPath, claudePath, config.anonymousIdPath] : []),
              writes: enabled ? [config.anonymousIdPath] : [],
              secretGets: enabled ? [CLOUD_LINKED_USER_ID] : [],
            },
          );
        }).pipe(
          Effect.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-telemetry-disabled-" }),
          ),
        ),
    );
  },
);
