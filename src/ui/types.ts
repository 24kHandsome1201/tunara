// Tunara UI 共用类型定义
import { AGENT_NAMES } from "../modules/agent/registry.ts";
import { t } from "../modules/i18n/core.ts";
import { defaultSessionTitle, isDefaultTitleIndex } from "../modules/session/default-title.ts";
import type { ConnectionEvidence } from "../modules/terminal/lib/connection-state.ts";
import type { WorkspaceContext } from "../modules/git/git-bridge.ts";
import type { RemoteGitErrorV1, RemoteState } from "../modules/git/git-bridge.ts";
import type { PreviewCommandProvenance, PreviewSource } from "../modules/preview/preview-source.ts";
import type { SshAuthMethod, SshHostProfile } from "../modules/ssh/hosts-model.ts";
import type { ForwardReconnectIntent } from "../modules/terminal/lib/pty-bridge.ts";
export { AGENT_NAMES };

/** Agent 类型代码（用于侧栏品牌识别） */
export type AgentCode = "CC" | "CX" | "CR" | "OC";

/** 会话运行状态 */
export type RunState = "idle" | "running" | "done" | "failed";

/** Agent 进程内的活动状态，独立于普通 shell 命令状态 */
export type AgentActivity = "starting" | "idle" | "running" | "waiting_confirmation";

/** Git 探测状态 */
export type GitState = "unknown" | "repo" | "notGit";

export type TerminalProgressState = "normal" | "error" | "indeterminate" | "warning";

export interface TerminalProgress {
  state: TerminalProgressState;
  value?: number;
  updatedAt: number;
}

export interface AgentResumeIntent {
  agent: AgentCode | string;
  command: string;
  cwd: string;
  provenance:
    | { transport: "local" }
    | { transport: "ssh"; host: string; port: number; user: string; identityFile?: string };
  resumeId?: string;
  lastSeenAt: number;
  confidence: "exact" | "continue" | "unknown";
}

/** 会话数据 */
export interface Session {
  id: string;
  agent?: AgentCode;
  agentActivity?: AgentActivity;
  agentResume?: AgentResumeIntent;
  title: string;
  dir: string;
  branch: string;

  // ── 生命周期 ──
  runState: RunState;
  startedAt?: number;
  completedAt?: number;
  unread?: boolean;
  /** Ephemeral transport evidence, independent from shell/agent run state. */
  connection?: ConnectionEvidence;

  // ── 用户自定义标题（优先级最高） ──
  customTitle?: string;
  /**
   * Set while the session keeps its numbered default name. The label is
   * rendered from i18n at display time; `title` only keeps a legacy snapshot.
   */
  defaultTitleIndex?: number;
  pinned?: boolean;

  // ── 动态标题源（Warp 风格瀑布推导） ──
  lastCommand?: string;
  lastExitCode?: number;
  shellTitle?: string;
  suppressShellTitle?: boolean;
  terminalProgress?: TerminalProgress;

  pendingInput?: string;
  pendingInputSubmit?: boolean;
  /** Ephemeral generation for reconnect attempts and preview identity. */
  reconnectNonce?: number;
  /** Separately advances only when a dead terminal must actually remount. */
  terminalMountNonce?: number;
  /** Runtime-only PTY/Channel generation currently allowed to mutate this session. */
  transportGeneration?: string;
  /** Runtime-only state for a TransportLost-triggered replacement shell. */
  sshReconnectAttempt?: number;
  /** Invalidates every timer/await owned by an older reconnect lifecycle. */
  sshReconnectLifecycle?: number;
  sshReconnectNeedsCredential?: boolean;
  sshReconnectForwards?: ForwardReconnectIntent[];
  /** Runtime-only: persist this host after the SSH session reports ready. */
  pendingSavedHost?: SshHostProfile;

  // ── SSH 远程会话（§ssh-client）。存在即为远程会话，否则为本地。 ──
  remote?: RemoteInfo;
  // 活动 PTY 的物理 id（运行时字段，不持久化）。远程会话的 SFTP 文件操作
  // 需要它来定位后端的 SSH 连接。
  ptyId?: number;
  // 用户在本地会话里手敲 ssh 时弹出的「改用内置 SSH 打开远程文件」建议
  // （运行时字段，不持久化）。null/缺省表示当前无建议。
  sshSuggestion?: SshConnectSuggestion | null;
  // 本会话内被用户忽略过的 ssh 目标，避免重复打扰（运行时字段，不持久化）。
  dismissedSshHosts?: string[];
  /** Runtime-only: Preview URLs the user dismissed or already opened. */
  dismissedPreviewKeys?: string[];
  /** Runtime-only: OSC 133 A/B/C/D was observed on this PTY. */
  shellIntegrationSeen?: boolean;
  /** Runtime-only: Agent just finished a turn; offer Changes if Git is dirty. */
  reviewChangesHint?: boolean;

  // ── git 改动 ──
  gitState?: GitState;
  gitFreshness?: "fresh" | "stale";
  gitError?: RemoteGitErrorV1;
  gitRemoteState?: RemoteState;
  // 不携带展示用 summary 字符串：本地化的统计行由 DiffPanel 按当前语言
  // 从 files 现算，后端/状态层不再固化任何 UI 语言。
  changes?: {
    files: ChangedFile[];
    commit?: string;
  };
  /** Read-only, refreshable Git repository/worktree context. Not persisted. */
  workspace?: WorkspaceContext;
  workspaceState?: "unknown" | "loading" | "ready" | "notGit" | "unavailable";
  /** Runtime-only localhost candidates, bound to their exact terminal/worktree source. */
  previewSources?: PreviewSource[];
  /** Runtime-only proof of the currently submitted OSC 133 shell command. */
  previewCommandProvenance?: PreviewCommandProvenance;

  updatedAt: number;
}

/**
 * 远程 SSH 会话连接信息。无密码字段——认证走 ssh-agent / 密钥文件，
 * 密码仅在连接时临时输入，绝不持久化。
 */
export interface RemoteInfo {
  host: string;
  port: number;
  user: string;
  /** Missing only on legacy snapshots; every new connection sets it explicitly. */
  authMethod?: SshAuthMethod;
  /** 私钥文件路径（如 ~/.ssh/id_ed25519），仅 key 模式使用。 */
  identityFile?: string;
  /** Optional OpenSSH user certificate paired with the private key. */
  certificateFile?: string;
  /** Persisted, secret-free, single-hop route. */
  route?: {
    profileId: string;
    jump: Pick<RemoteInfo, "host" | "port" | "user" | "authMethod" | "identityFile" | "certificateFile">;
  };
  /**
   * Phase 4：连接时向远程 shell 注入集成脚本，启用远程 cwd / 命令边界 /
   * agent 检测。默认开启——失败时静默降级，可由用户显式关闭。
   */
  injectShellIntegration?: boolean;
  /** Explicit opt-in. Missing and false both disable automatic reconnect. */
  autoReconnect?: boolean;
  /** Typed into the shell after every (re)connect, e.g. `herdr` to reattach. */
  postConnectCommand?: string;
}

/**
 * 检测到用户手敲 ssh 后给出的连接建议。只含命令行能读到的字段，
 * 用于预填新建 SSH 会话对话框——密码/口令绝不来自这里。
 */
export interface SshConnectSuggestion {
  host: string;
  user?: string;
  port?: number;
}

/** Transient form state for a new SSH connection or an in-place reconnect. */
export interface SshConnectPrefill extends SshConnectSuggestion {
  authMethod?: SshAuthMethod;
  identityFile?: string;
  certificateFile?: string;
  route?: RemoteInfo["route"];
  reconnectForwards?: ForwardReconnectIntent[];
  injectShellIntegration?: boolean;
  autoReconnect?: boolean;
  postConnectCommand?: string;
  reconnectSessionId?: string;
}

/** Secret-free replacement-shell intent shared by every reconnect entry. */
export function reconnectPrefillFromSession(session: Session): SshConnectPrefill | null {
  const remote = session.remote;
  if (!remote) return null;
  return {
    host: remote.host,
    port: remote.port,
    user: remote.user,
    authMethod: remote.authMethod,
    identityFile: remote.identityFile,
    certificateFile: remote.certificateFile,
    route: remote.route,
    ...(session.sshReconnectForwards !== undefined ? { reconnectForwards: session.sshReconnectForwards } : {}),
    injectShellIntegration: remote.injectShellIntegration,
    autoReconnect: remote.autoReconnect,
    ...(remote.postConnectCommand ? { postConnectCommand: remote.postConnectCommand } : {}),
    reconnectSessionId: session.id,
  };
}

/** 改动文件（与后端 git FileChange 对齐） */
export interface ChangedFile {
  path: string;
  status: string;
  stage: "staged" | "unstaged" | "untracked";
  added: number;
  removed: number;
  patch?: string;
}

/** 覆盖层类型 */
export type OverlayType = null | "settings" | "command-palette" | "ssh";

/** 主题：浅色 / 深色 / 跟随系统。已删除的命名终端配色回退为 system。 */
export type ThemeType = "light" | "dark" | "system";

function shortDir(dir: string): string {
  if (dir === "~") return "~";
  const parts = dir.replace(/^~\//, "").replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || dir;
}

export function isPromptLikeShellTitle(title: string): boolean {
  return /(?:^|\s)[^@\s]+@[^%#$\n]+.*\s[%#$](?:\s|$)/.test(title.trim());
}

export function deriveTitle(s: Session): { primary: string; subtitle: string; isCommand: boolean; totalAdded: number; totalRemoved: number } {
  // A card title is session identity, not live terminal activity. The store
  // assigns a durable numbered title when a session is added; commands, OSC
  // titles, and agent lifecycle updates must not replace that identity.
  const primary = s.customTitle
    || (isDefaultTitleIndex(s.defaultTitleIndex) ? defaultSessionTitle(s.defaultTitleIndex) : "")
    || (s.title && !isPromptLikeShellTitle(s.title) ? s.title : t("session.default_title"));

  const dirLabel = shortDir(s.dir);
  const parts: string[] = [];
  if (s.pinned) parts.push("★");
  if (s.branch) parts.push(`⎇ ${s.branch}`);
  parts.push(dirLabel);
  let totalAdded = 0;
  let totalRemoved = 0;
  if (s.changes?.files?.length) {
    for (const file of s.changes.files) {
      totalAdded += file.added;
      totalRemoved += file.removed;
    }
  }

  if (s.changes?.files?.length) {
    const diffParts: string[] = [];
    if (totalAdded > 0) diffParts.push(`+${totalAdded}`);
    if (totalRemoved > 0) diffParts.push(`-${totalRemoved}`);
    if (diffParts.length) parts.push(diffParts.join(" "));
  }

  return { primary, subtitle: parts.join(" · "), isCommand: false, totalAdded, totalRemoved };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
