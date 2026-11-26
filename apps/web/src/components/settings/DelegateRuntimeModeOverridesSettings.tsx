import { isManagedSettingPath, type DelegateRuntimeModeOverride } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react";
import { PlusIcon, XIcon } from "lucide-react";

import { useEnvironmentProviders } from "../../state/environments";
import { runtimeModeConfig, runtimeModeOptions } from "../chat/runtimeModeConfig";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const settingKeys = ["delegateRuntimeModeOverrides"] as const;

export function DelegateRuntimeModeOverridesRow() {
  const gt = useGT();
  const m = useMessages();
  const setting = useSearchableSetting();
  const rules = useScopedSettings((settings) => settings.delegateRuntimeModeOverrides) ?? [];
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(settingKeys);
  const { environment, connectedEnvironments } = useSettingsScope();
  const providersByEnvironment = useEnvironmentProviders();
  const providers = environment
    ? (providersByEnvironment.get(environment.environmentId) ?? [])
    : [];
  const firstProvider = providers[0];
  const disabled =
    mixed ||
    connectedEnvironments.some(({ serverConfig }) =>
      isManagedSettingPath(serverConfig?.managedPolicy, settingKeys[0]),
    );
  const replaceRule = (index: number, next: DelegateRuntimeModeOverride) =>
    updateSettings({
      delegateRuntimeModeOverrides: rules.map((rule, position) =>
        position === index ? next : rule,
      ),
    });
  const allModels = gt("All models");

  return (
    <SettingsRow
      serverScoped
      settingKeys={settingKeys}
      mixed={mixed}
      {...setting("delegate-runtime-mode-overrides")}
      description={gt(
        "Override permissions for delegated tasks per provider and model. A mode explicitly requested by the delegating agent takes precedence.",
      )}
      status={mixed ? gt("Select one environment to edit its overrides.") : undefined}
    >
      <div className="space-y-2 py-2">
        {rules.map((rule, index) => {
          const provider = providers.find(
            ({ instanceId }) => instanceId === rule.providerInstanceId,
          );
          const models = provider?.models ?? [];
          const model = models.find(({ slug }) => slug === rule.model);
          const runtimeMode = runtimeModeConfig[rule.runtimeMode];
          const RuntimeIcon = runtimeMode.icon;
          return (
            // oxlint-disable-next-line react/no-array-index-key -- Rules are an ID-less array because settings patches replace arrays whole; every field here is controlled, so a shifted key only remounts closed selects.
            <div key={index} className="flex flex-wrap items-center gap-2">
              <div className="min-w-36 flex-1">
                <Select
                  value={rule.providerInstanceId}
                  disabled={disabled}
                  onValueChange={(providerInstanceId) => {
                    if (
                      providerInstanceId !== null &&
                      providerInstanceId !== rule.providerInstanceId
                    ) {
                      replaceRule(index, { providerInstanceId, runtimeMode: rule.runtimeMode });
                    }
                  }}
                >
                  <SelectTrigger size="sm" aria-label={gt("Provider instance")}>
                    <SelectValue>{provider?.displayName ?? rule.providerInstanceId}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {!provider && (
                      <SelectItem value={rule.providerInstanceId}>
                        {rule.providerInstanceId}
                      </SelectItem>
                    )}
                    {providers.map(({ instanceId, displayName }) => (
                      <SelectItem key={instanceId} value={instanceId}>
                        {displayName ?? instanceId}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <div className="min-w-36 flex-1">
                <Select
                  value={rule.model ?? ""}
                  disabled={disabled}
                  onValueChange={(slug) => {
                    if (slug === null) return;
                    replaceRule(index, {
                      providerInstanceId: rule.providerInstanceId,
                      runtimeMode: rule.runtimeMode,
                      ...(slug === "" ? {} : { model: slug }),
                    });
                  }}
                >
                  <SelectTrigger size="sm" aria-label={gt("Model")}>
                    <SelectValue>{model?.name ?? rule.model ?? allModels}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="">{allModels}</SelectItem>
                    {rule.model !== undefined && !model && (
                      <SelectItem value={rule.model}>{rule.model}</SelectItem>
                    )}
                    {models.map(({ slug, name }) => (
                      <SelectItem key={slug} value={slug}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <div className="min-w-36 flex-1">
                <Select
                  value={rule.runtimeMode}
                  disabled={disabled}
                  onValueChange={(mode) => {
                    if (mode !== null) replaceRule(index, { ...rule, runtimeMode: mode });
                  }}
                >
                  <SelectTrigger size="sm" aria-label={gt("Permissions")}>
                    <RuntimeIcon className="size-3.5 shrink-0" />
                    <SelectValue>{m(runtimeMode.label)}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {runtimeModeOptions.map((mode) => {
                      const option = runtimeModeConfig[mode];
                      const Icon = option.icon;
                      return (
                        <SelectItem key={mode} value={mode}>
                          <span className="inline-flex items-center gap-1.5">
                            <Icon className="size-3.5 shrink-0" />
                            {m(option.label)}
                          </span>
                        </SelectItem>
                      );
                    })}
                  </SelectPopup>
                </Select>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={disabled}
                aria-label={gt("Remove override")}
                onClick={() =>
                  updateSettings({
                    delegateRuntimeModeOverrides: rules.filter((_, position) => position !== index),
                  })
                }
              >
                <XIcon aria-hidden />
              </Button>
            </div>
          );
        })}
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || !firstProvider}
          onClick={() => {
            if (!firstProvider) return;
            updateSettings({
              delegateRuntimeModeOverrides: [
                ...rules,
                { providerInstanceId: firstProvider.instanceId, runtimeMode: "approval-required" },
              ],
            });
          }}
        >
          <PlusIcon aria-hidden />
          {gt("Add override")}
        </Button>
      </div>
    </SettingsRow>
  );
}
