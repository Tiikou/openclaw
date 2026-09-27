import { isDeepStrictEqual } from "node:util";
import { createRuntimePluginManifestLookup } from "./active-runtime-registry.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { getPluginInstance } from "./plugin-instance-scope.js";
import { isPluginRecordActive, isPluginRegistryRetired } from "./registry-lifecycle.js";
import type { PluginRegistry } from "./registry-types.js";
import { getActivePluginRegistry } from "./runtime.js";
import { getPluginRuntimeLoadContext } from "./runtime/load-context.js";

function samePluginManifestAcrossWorkspaces(
  target: PluginManifestRecord | undefined,
  donor: PluginManifestRecord | undefined,
): boolean {
  if (!target || !donor) {
    return false;
  }
  const { workspaceDir: _targetWorkspace, ...targetOwner } = target;
  const { workspaceDir: _donorWorkspace, ...donorOwner } = donor;
  return isDeepStrictEqual(targetOwner, donorOwner);
}

/** Borrow hooks whose discovery instance cannot own the live plugin's state. */
export function adoptRuntimeTypedHookRegistrations(
  target: PluginRegistry,
  donor: PluginRegistry,
): PluginRegistry {
  if (target === donor || getActivePluginRegistry() !== donor || isPluginRegistryRetired(target)) {
    return target;
  }
  const targetContext = getPluginRuntimeLoadContext(target);
  const donorContext = getPluginRuntimeLoadContext(donor);
  const manifests = targetContext?.manifestRegistry?.plugins;
  const donorManifests = donorContext?.manifestRegistry?.plugins;
  if (
    !targetContext ||
    !donorContext ||
    targetContext.env !== process.env ||
    !isDeepStrictEqual({ ...targetContext.env }, { ...donorContext.env }) ||
    targetContext.registrationConfigKey !== donorContext.registrationConfigKey ||
    !manifests ||
    !donorManifests
  ) {
    return target;
  }
  const selectedTarget = createRuntimePluginManifestLookup(
    target,
    manifests,
    targetContext.preferBuiltPluginArtifacts,
  );
  const selectedDonor = createRuntimePluginManifestLookup(
    donor,
    donorManifests,
    donorContext.preferBuiltPluginArtifacts,
  );
  const locallyRegistered = new Set(
    target.typedHooks.map((hook) => `${hook.pluginId}\0${hook.hookName}`),
  );
  const adopted = donor.typedHooks.flatMap((hook) => {
    if (locallyRegistered.has(`${hook.pluginId}\0${hook.hookName}`)) {
      return [];
    }
    const record = selectedTarget(hook.pluginId);
    const donorRecord = selectedDonor(hook.pluginId);
    const local = record && getPluginInstance(record);
    const runtime = donorRecord && getPluginInstance(donorRecord);
    if (
      !record?.enabled ||
      record.status !== "loaded" ||
      !donorRecord ||
      donorRecord.status !== "loaded" ||
      !local?.acceptingCalls ||
      !runtime?.acceptingCalls ||
      !isPluginRecordActive(donor, donorRecord) ||
      record.source !== donorRecord.source ||
      local.sourceDigest !== runtime.sourceDigest ||
      !samePluginManifestAcrossWorkspaces(
        manifests.find((manifest) => manifest.id === hook.pluginId),
        donorManifests.find((manifest) => manifest.id === hook.pluginId),
      )
    ) {
      return [];
    }
    return [
      {
        ...hook,
        handler: local.wrap(runtime.wrap(hook.handler)),
        borrowedRuntimeRecord: donorRecord,
      },
    ];
  });
  if (getActivePluginRegistry() !== donor) {
    throw new Error("Typed hook runtime owner changed during prepared registry admission");
  }
  return adopted.length ? { ...target, typedHooks: [...target.typedHooks, ...adopted] } : target;
}
