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
  /** Per-host reconnect preference; missing means off. */
  autoReconnect?: boolean;
  /** Per-host remote shell integration preference; missing means on. */
  injectShellIntegration?: boolean;
  /** Typed into the remote shell after each (re)connect, e.g. `herdr`. */
  postConnectCommand?: string;
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
  auto_reconnect?: boolean;
  shell_integration_disabled?: boolean;
  post_connect_command?: string;
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
    ...(r.auto_reconnect === true ? { autoReconnect: true } : {}),
    ...(r.shell_integration_disabled === true ? { injectShellIntegration: false } : {}),
    ...(normalizePostConnectCommand(r.post_connect_command) ? { postConnectCommand: normalizePostConnectCommand(r.post_connect_command) } : {}),
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
    auto_reconnect: p.autoReconnect === true,
    shell_integration_disabled: p.injectShellIntegration === false,
    post_connect_command: normalizePostConnectCommand(p.postConnectCommand),
  };
}

const MAX_POST_CONNECT_COMMAND_LENGTH = 512;

/** Single-line, bounded command; anything else is dropped rather than typed into a shell. */
export function normalizePostConnectCommand(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const command = raw.trim();
  if (!command || command.length > MAX_POST_CONNECT_COMMAND_LENGTH) return "";
  if (/[\u0000-\u001f\u007f]/.test(command)) return "";
  return command;
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

/** One host row. A saved profile shadows the ~/.ssh/config entry for the same endpoint. */
export interface SshProfileEntryV1 {
  key: string;
  source: SshProfileSourceV1;
  profile: SshHostProfile;
  /** The config entry this saved row also stands for; kept so its alias and keys stay usable. */
  configProfile?: SshHostProfile;
}

function sshProfileEndpointKey(profile: SshHostProfile): string {
  return `${profile.user}@${profile.host.toLowerCase()}:${profile.port}>${profile.proxyJumpProfileId ?? ""}`;
}

/**
 * Host rows for lists: saved first, then config entries no saved profile covers.
 * Saving a connection picked from ~/.ssh/config otherwise showed the host twice.
 * The panel model itself is untouched, so route/jump resolution still sees both.
 */
export function sshProfileEntries(model: SshProfilesPanelModelV1): SshProfileEntryV1[] {
  const configByEndpoint = new Map<string, SshHostProfile>();
  for (const profile of model.configProfiles) {
    const key = sshProfileEndpointKey(profile);
    if (!configByEndpoint.has(key)) configByEndpoint.set(key, profile);
  }
  const shadowed = new Set<SshHostProfile>();
  const saved = model.savedProfiles.map((profile): SshProfileEntryV1 => {
    const config = configByEndpoint.get(sshProfileEndpointKey(profile));
    const configProfile = config && !shadowed.has(config) ? config : undefined;
    if (configProfile) shadowed.add(configProfile);
    return { key: `saved:${profile.id}`, source: "saved", profile, ...(configProfile ? { configProfile } : {}) };
  });
  const config = model.configProfiles
    .filter((profile) => !shadowed.has(profile))
    .map((profile): SshProfileEntryV1 => ({ key: `sshConfig:${profile.id}`, source: "sshConfig", profile }));
  return [...saved, ...config];
}
