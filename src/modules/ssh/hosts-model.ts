/**
 * 已保存的 SSH 主机 profile（与后端 SshHostProfile 对齐）。
 * 不含任何凭证字段，密码/口令绝不落盘。
 */
export const SSH_AUTH_METHODS = ["auto", "agent", "key", "password", "keyboard-interactive"] as const;
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
  /** Missing only for profiles created before explicit authentication. `auto` is the default connect strategy. */
  authMethod?: SshAuthMethod;
  /** Private-key path. Used by `key`, and as a preferred IdentityFile hint for `auto`. */
  identityFile: string;
  /** Optional OpenSSH user certificate paired with identityFile. */
  certificateFile?: string;
  /** Resolved single-hop route. The B1 UI must not open it as a direct host. */
  proxyJumpProfileId?: string;
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
  certificate_file?: string;
  proxy_jump_profile_id?: string;
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
    ...(r.certificate_file ? { certificateFile: r.certificate_file } : {}),
    ...(r.proxy_jump_profile_id ? { proxyJumpProfileId: r.proxy_jump_profile_id } : {}),
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
    certificate_file: p.certificateFile ?? "",
    proxy_jump_profile_id: p.proxyJumpProfileId ?? "",
  };
}

export function makeHostId(): string {
  return `host-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

/** Raw shape of the backend `SshImportResult` (snake_case). */
export interface RawSshImportResult {
  imported: RawHostProfile[];
  skipped: number;
  diagnostics?: RawSshImportDiagnostic[];
}

export interface RawSshImportDiagnostic {
  source: string;
  line: number;
  alias: string;
  code: string;
  directive: string;
  severity?: "warning" | "error";
}

/** Stable config-import diagnostic consumed by the F3 panel. */
export interface SshImportDiagnosticV1 {
  source: string;
  line?: number;
  alias?: string;
  code: string;
  directive?: string;
  severity: "warning" | "error";
}

/** Compatibility name retained for existing consumers. */
export type SshImportDiagnostic = SshImportDiagnosticV1;

/** Parsed import result (camelCase profiles). */
export interface SshImportResult {
  imported: SshHostProfile[];
  skipped: number;
  diagnostics: SshImportDiagnostic[];
}

export function toImportResult(r: RawSshImportResult): SshImportResult {
  return {
    imported: r.imported.map(toProfile),
    skipped: r.skipped,
    diagnostics: (r.diagnostics ?? []).map((diagnostic) => ({
      ...diagnostic,
      severity: diagnostic.severity ?? "error",
    })),
  };
}

export type SshProfileSourceV1 = "saved" | "sshConfig";

/** No credentials are present here; F3 obtains one-shot secrets separately. */
export interface SshProfileRouteV1 {
  schemaVersion: 1;
  source: SshProfileSourceV1;
  target: SshHostProfile;
  jump?: SshHostProfile;
}

export type SshProfileRouteResolutionV1 =
  | { status: "ready"; route: SshProfileRouteV1 }
  | {
      status: "rejected";
      code: "profileMissing" | "jumpMissing" | "jumpAmbiguous" | "jumpRouted";
      profileId: string;
      jumpProfileId?: string;
    };

/** Data-only panel boundary. Shared UI files may render it without knowing IPC shapes. */
export interface SshProfilesPanelModelV1 {
  schemaVersion: 1;
  savedProfiles: SshHostProfile[];
  configProfiles: SshHostProfile[];
  configSkipped: number;
  configDiagnostics: SshImportDiagnosticV1[];
}

/** Callbacks owned by F3 shared wiring; Stream B does not edit shared panels. */
export interface SshProfilesPanelActionsV1 {
  onConnect: (route: SshProfileRouteV1) => void | Promise<void>;
  onSave: (profile: SshHostProfile) => void | Promise<void>;
  onRemove: (profileId: string) => void | Promise<void>;
  onRefreshConfig: () => void | Promise<void>;
  onOpenConfigDiagnostic: (diagnostic: SshImportDiagnosticV1) => void;
}

export function toProfilesPanelModel(
  savedProfiles: SshHostProfile[],
  config: SshImportResult,
): SshProfilesPanelModelV1 {
  return {
    schemaVersion: 1,
    savedProfiles,
    configProfiles: config.imported,
    configSkipped: config.skipped,
    configDiagnostics: config.diagnostics,
  };
}

export function resolveSshProfileRoute(
  profileId: string,
  source: SshProfileSourceV1,
  model: SshProfilesPanelModelV1,
): SshProfileRouteResolutionV1 {
  const sourceProfiles = source === "saved" ? model.savedProfiles : model.configProfiles;
  const target = sourceProfiles.find((profile) => profile.id === profileId);
  if (!target) return { status: "rejected", code: "profileMissing", profileId };
  if (!target.proxyJumpProfileId) {
    return { status: "ready", route: { schemaVersion: 1, source, target } };
  }
  const allProfiles = [...model.savedProfiles, ...model.configProfiles];
  const jumps = allProfiles.filter((profile) => profile.id === target.proxyJumpProfileId);
  if (jumps.length === 0) {
    return {
      status: "rejected",
      code: "jumpMissing",
      profileId,
      jumpProfileId: target.proxyJumpProfileId,
    };
  }
  if (jumps.length !== 1) {
    return {
      status: "rejected",
      code: "jumpAmbiguous",
      profileId,
      jumpProfileId: target.proxyJumpProfileId,
    };
  }
  if (jumps[0].proxyJumpProfileId) {
    return {
      status: "rejected",
      code: "jumpRouted",
      profileId,
      jumpProfileId: target.proxyJumpProfileId,
    };
  }
  return {
    status: "ready",
    route: { schemaVersion: 1, source, target, jump: jumps[0] },
  };
}
