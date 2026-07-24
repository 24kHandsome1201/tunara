/**
 * 已保存的 SSH 主机 profile（与后端 SshHostProfile 对齐）。
 * 不含任何凭证字段，密码/口令绝不落盘。
 */
export const SSH_AUTH_METHODS = ["agent", "key", "password", "keyboard-interactive"] as const;
export type SshAuthMethod = typeof SSH_AUTH_METHODS[number];

export function isSshAuthMethod(value: unknown): value is SshAuthMethod {
  return typeof value === "string" && (SSH_AUTH_METHODS as readonly string[]).includes(value);
}

export interface SshHostProfile {
  id: string;
  label: string;
  host: string;
  port: number;
  user: string;
  /** Missing only for profiles created before explicit authentication. */
  authMethod?: SshAuthMethod;
  /** Private-key path. Ignored unless authMethod is `key`. */
  identityFile: string;
}

// 后端用 snake_case（serde 默认），前端用 camelCase，在边界转换。
export interface RawHostProfile {
  id: string;
  label: string;
  host: string;
  port: number;
  user: string;
  auth_method?: SshAuthMethod | null;
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
    ...(isSshAuthMethod(r.auth_method) ? { authMethod: r.auth_method } : {}),
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
    auth_method: p.authMethod ?? null,
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
