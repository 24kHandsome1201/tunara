import { invoke } from "@tauri-apps/api/core";

/**
 * 已保存的 SSH 主机 profile（与后端 SshHostProfile 对齐）。
 * 不含任何凭证字段——密码/口令绝不落盘。
 */
export interface SshHostProfile {
  id: string;
  label: string;
  host: string;
  port: number;
  user: string;
  /** 私钥路径；空串表示走 ssh-agent。 */
  identityFile: string;
}

// 后端用 snake_case（serde 默认），前端用 camelCase，在边界转换。
interface RawHostProfile {
  id: string;
  label: string;
  host: string;
  port: number;
  user: string;
  identity_file: string;
}

function toProfile(r: RawHostProfile): SshHostProfile {
  return {
    id: r.id,
    label: r.label,
    host: r.host,
    port: r.port,
    user: r.user,
    identityFile: r.identity_file,
  };
}

function toRaw(p: SshHostProfile): RawHostProfile {
  return {
    id: p.id,
    label: p.label,
    host: p.host,
    port: p.port,
    user: p.user,
    identity_file: p.identityFile,
  };
}

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

export function makeHostId(): string {
  return `host-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}
