/**
 * 已保存的 SSH 主机 profile（与后端 SshHostProfile 对齐）。
 * 不含任何凭证字段，密码/口令绝不落盘。
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
export interface RawHostProfile {
  id: string;
  label: string;
  host: string;
  port: number;
  user: string;
  identity_file: string;
}

export function parseSshPort(raw: unknown): number | null {
  const value = typeof raw === "number"
    ? raw
    : typeof raw === "string" && /^\d+$/.test(raw.trim())
    ? Number(raw.trim())
    : Number.NaN;
  return Number.isInteger(value) && value >= 1 && value <= 65_535
    ? value
    : null;
}

export function normalizeSshPort(raw: unknown, fallback = 22): number {
  return parseSshPort(raw) ?? parseSshPort(fallback) ?? 22;
}

export function toProfile(r: RawHostProfile): SshHostProfile {
  return {
    id: r.id,
    label: r.label,
    host: r.host,
    port: normalizeSshPort(r.port),
    user: r.user,
    identityFile: r.identity_file,
  };
}

export function toRaw(p: SshHostProfile): RawHostProfile {
  return {
    id: p.id,
    label: p.label,
    host: p.host,
    port: normalizeSshPort(p.port),
    user: p.user,
    identity_file: p.identityFile,
  };
}

export function makeHostId(): string {
  return `host-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

/** Raw shape of the backend `SshImportResult` (snake_case). */
export interface RawSshImportResult {
  imported: RawHostProfile[];
  skipped: number;
}

/** Parsed import result (camelCase profiles). */
export interface SshImportResult {
  imported: SshHostProfile[];
  skipped: number;
}

export function toImportResult(r: RawSshImportResult): SshImportResult {
  return { imported: r.imported.map(toProfile), skipped: r.skipped };
}

/**
 * Return only the incoming profiles whose `id` is not already in `existing`.
 * Used by the ~/.ssh/config import flow to append new aliases without
 * overwriting a user's manual edits to an already-imported host. The backend
 * assigns imported profiles a stable `ssh-config-<alias>` id, so re-importing
 * the same config is idempotent (nothing new returned on the second pass).
 */
export function filterNewHostsById(
  existing: SshHostProfile[],
  incoming: SshHostProfile[],
): SshHostProfile[] {
  const existingIds = new Set(existing.map((p) => p.id));
  return incoming.filter((p) => !existingIds.has(p.id));
}
