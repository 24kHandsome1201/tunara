import { invoke } from "@tauri-apps/api/core";

export interface KnownHostEntryV1 {
  entryId: string;
  line: number;
  marker: string | null;
  patternDisplay: string;
  keyType: string;
  fingerprint: string;
  manageable: boolean;
}
export interface KnownHostsSnapshotV1 { revision: string; entries: KnownHostEntryV1[] }

export const listKnownHostsV1 = (): Promise<KnownHostsSnapshotV1> => invoke("ssh_known_hosts_list_v1");
export const refreshKnownHostsV1 = (): Promise<KnownHostsSnapshotV1> => invoke("ssh_known_hosts_refresh_v1");
export const removeKnownHostV1 = (expectedRevision: string, entryId: string): Promise<KnownHostsSnapshotV1> =>
  invoke("ssh_known_hosts_remove_v1", { expectedRevision, entryId });
