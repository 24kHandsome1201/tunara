import { invoke } from "@tauri-apps/api/core";
import { toProfile, toRaw, toImportResult, toProfilesPanelModel, type RawHostProfile, type RawSshImportResult, type SshHostProfile, type SshImportResult, type SshProfilesPanelModelV1 } from "./hosts-model.ts";

export { SSH_AUTH_METHODS, isSshAuthMethod, makeHostId, normalizeSshPort, parseSshPort, toProfile, toRaw, toImportResult, toProfilesPanelModel, resolveSshProfileRoute, type RawHostProfile, type RawSshImportDiagnostic, type RawSshImportResult, type SshAuthMethod, type SshHostProfile, type SshImportDiagnostic, type SshImportDiagnosticV1, type SshImportResult, type SshProfileRouteResolutionV1, type SshProfileRouteV1, type SshProfileSourceV1, type SshProfilesPanelActionsV1, type SshProfilesPanelModelV1 } from "./hosts-model.ts";

export async function loadHosts(): Promise<SshHostProfile[]> {
  const raw = await invoke<RawHostProfile[]>("ssh_hosts_load");
  return raw.map(toProfile);
}

export async function saveHost(profile: SshHostProfile): Promise<SshHostProfile[]> {
  const raw = await invoke<RawHostProfile[]>("ssh_hosts_save", { profile: toRaw(profile) });
  return raw.map(toProfile);
}

export async function removeHost(id: string): Promise<SshHostProfile[]> {
  const raw = await invoke<RawHostProfile[]>("ssh_hosts_remove", { id });
  return raw.map(toProfile);
}

export async function importSshConfig(): Promise<SshImportResult> {
  const raw = await invoke<RawSshImportResult>("ssh_hosts_import_config");
  return toImportResult(raw);
}

/** Snapshot loader for F3. It intentionally performs no connect or secret action. */
export async function loadSshProfilesPanel(): Promise<SshProfilesPanelModelV1> {
  const [savedProfiles, config] = await Promise.all([loadHosts(), importSshConfig()]);
  return toProfilesPanelModel(savedProfiles, config);
}
