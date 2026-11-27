import {
  clampManagedRuntimeMode,
  type DelegateRuntimeModeOverride,
  type ManagedPolicySummary,
  type OrchestratorMcpRuntimeMode,
  type ProviderInstanceId,
  type RuntimeMode,
} from "@t3tools/contracts";

import { resolveRuntimeMode } from "./delegatedTaskModes.ts";

export function findDelegateRuntimeModeOverride(
  overrides: ReadonlyArray<DelegateRuntimeModeOverride>,
  instanceId: ProviderInstanceId,
  model: string,
): RuntimeMode | undefined {
  let instanceMode: RuntimeMode | undefined;
  for (const rule of overrides) {
    if (rule.providerInstanceId !== instanceId) continue;
    if (rule.model === model) return rule.runtimeMode;
    if (rule.model === undefined) instanceMode ??= rule.runtimeMode;
  }
  return instanceMode;
}

export function resolveDelegateRuntimeMode(input: {
  readonly parentMode: RuntimeMode;
  readonly requested: OrchestratorMcpRuntimeMode | undefined;
  readonly target: NonNullable<Parameters<typeof resolveRuntimeMode>[2]>;
  readonly override: RuntimeMode | undefined;
  readonly managedPolicy: ManagedPolicySummary | undefined;
}) {
  const { parentMode, requested, target, override, managedPolicy } = input;
  if (override === undefined || (requested !== undefined && requested !== "inherit")) {
    return resolveRuntimeMode(parentMode, requested, target);
  }
  const clamped = clampManagedRuntimeMode(managedPolicy, override) ?? "approval-required";
  return resolveRuntimeMode(clamped, undefined, target);
}
