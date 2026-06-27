import { invoke } from "@tauri-apps/api/core";
import { toProfile, toRaw, type RawHostProfile, type SshHostProfile } from "./hosts-model.ts";

export { makeHostId, toProfile, toRaw, type RawHostProfile, type SshHostProfile } from "./hosts-model.ts";

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
