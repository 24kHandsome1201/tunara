import { invoke } from "@tauri-apps/api/core";
import { toProfile, toRaw, toImportResult, type RawHostProfile, type RawSshImportResult, type SshHostProfile, type SshImportResult } from "./hosts-model.ts";

export { SSH_AUTH_METHODS, isSshAuthMethod, makeHostId, normalizeSshPort, parseSshPort, toProfile, toRaw, toImportResult, type RawHostProfile, type RawSshImportResult, type SshAuthMethod, type SshHostProfile, type SshImportResult } from "./hosts-model.ts";

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
