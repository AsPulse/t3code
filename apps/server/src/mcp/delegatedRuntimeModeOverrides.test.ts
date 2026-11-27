import { assert, describe, it } from "@effect/vitest";
import {
  type DelegateRuntimeModeOverride,
  type OrchestratorMcpRuntimeMode,
  ProviderInstanceId,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  findDelegateRuntimeModeOverride,
  resolveDelegateRuntimeMode,
} from "./delegatedRuntimeModeOverrides.ts";

const instanceId = ProviderInstanceId.make("codex-work");
const model = "test-model";
const modelSelection = { instanceId, model };
const modelRule = { providerInstanceId: instanceId, model, runtimeMode: "full-access" } as const;
const instanceRule = { providerInstanceId: instanceId, runtimeMode: "auto" } as const;
describe("findDelegateRuntimeModeOverride", () => {
  it("ignores rules for another instance of the same driver or another model", () => {
    const rules: ReadonlyArray<DelegateRuntimeModeOverride> = [
      { ...modelRule, providerInstanceId: ProviderInstanceId.make("codex") },
      { ...modelRule, model: "different-model" },
    ];
    assert.isUndefined(findDelegateRuntimeModeOverride(rules, instanceId, model));
  });

  it("uses the first instance-wide rule when no model rule matches", () => {
    const rules: ReadonlyArray<DelegateRuntimeModeOverride> = [
      instanceRule,
      { ...instanceRule, runtimeMode: "approval-required" },
      modelRule,
    ];
    assert.equal(findDelegateRuntimeModeOverride(rules, instanceId, "different-model"), "auto");
  });

  it("uses the first matching model rule ahead of an instance-wide rule", () => {
    const rules: ReadonlyArray<DelegateRuntimeModeOverride> = [
      instanceRule,
      modelRule,
      { ...modelRule, runtimeMode: "approval-required" },
    ];
    assert.equal(findDelegateRuntimeModeOverride(rules, instanceId, model), "full-access");
  });
});

describe("resolveDelegateRuntimeMode", () => {
  const base = {
    parentMode: "auto",
    requested: undefined,
    target: { modelSelection, supportedRuntimeModes: undefined },
    override: "full-access",
    managedPolicy: undefined,
  } as const;

  it.effect.each<OrchestratorMcpRuntimeMode | undefined>([undefined, "inherit"])(
    "allows a broader override for %s",
    (requested) =>
      Effect.gen(function* () {
        assert.equal(yield* resolveDelegateRuntimeMode({ ...base, requested }), "full-access");
      }),
  );

  it.effect("allows a narrower override", () =>
    Effect.gen(function* () {
      assert.equal(
        yield* resolveDelegateRuntimeMode({ ...base, override: "approval-required" }),
        "approval-required",
      );
    }),
  );

  it.effect("keeps the normal checks for an explicit request", () =>
    Effect.gen(function* () {
      assert.equal(
        yield* resolveDelegateRuntimeMode({ ...base, requested: "auto-accept-edits" }),
        "auto-accept-edits",
      );
      const error = yield* resolveDelegateRuntimeMode({ ...base, requested: "full-access" }).pipe(
        Effect.flip,
      );
      assert.equal(error.code, "runtime_mode_escalation_denied");
    }),
  );

  it.effect("keeps inheritance when there is no override", () =>
    Effect.gen(function* () {
      assert.equal(yield* resolveDelegateRuntimeMode({ ...base, override: undefined }), "auto");
    }),
  );

  it.effect("falls back to the broadest supported mode under the managed ceiling", () =>
    Effect.gen(function* () {
      const managedPolicy = {
        organization: "Test organization",
        lockedSettings: [],
        limits: { maxRuntimeMode: "auto" },
      } as const;
      assert.equal(yield* resolveDelegateRuntimeMode({ ...base, managedPolicy }), "auto");
      const supportedRuntimeModes: ReadonlyArray<RuntimeMode> = [
        "approval-required",
        "full-access",
        "auto-accept-edits",
      ];
      assert.equal(
        yield* resolveDelegateRuntimeMode({
          ...base,
          managedPolicy,
          target: { modelSelection, supportedRuntimeModes },
        }),
        "auto-accept-edits",
      );
    }),
  );
});
