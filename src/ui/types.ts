// Tunara UI 共用类型定义
import { AGENT_NAMES } from "../modules/agent/registry.ts";
import { t } from "../modules/i18n/core.ts";
import type { ConnectionEvidence } from "../modules/terminal/lib/connection-state.ts";
import type { SessionMascotId } from "../modules/session/session-mascot.ts";
import type { WorkspaceContext } from "../modules/git/git-bridge.ts";
import type { PreviewCommandProvenance, PreviewSource } from "../modules/preview/preview-source.ts";
import type { SshAuthMethod } from "../modules/ssh/hosts-model.ts";
export { AGENT_NAMES };

/** Agent 类型代码（用于侧栏品牌识别） */
export type AgentCode = "CC" | "CX" | "AM" | "GM" | "CP" | "CR" | "DR" | "OC" | "PI" | "AG" | "DV" | "AD";

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
  mascot?: SessionMascotId;
  pinned?: boolean;
  note?: string;

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

  // ── git 改动 ──
  gitState?: GitState;
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
  /**
   * Phase 4：连接时向远程 shell 注入集成脚本，启用远程 cwd / 命令边界 /
   * agent 检测。默认开启——失败时静默降级，可由用户显式关闭。
   */
  injectShellIntegration?: boolean;
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
  injectShellIntegration?: boolean;
  reconnectSessionId?: string;
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

/** 主题 */
export type ThemeType = "light" | "dark" | "system";

/** 终端配色主题 */
export const TERMINAL_THEME_NAMES = ["default", "catppuccin", "tokyo-night", "one-dark", "solarized", "github-light", "rose-pine-dawn"] as const;
export type TerminalThemeName = typeof TERMINAL_THEME_NAMES[number];

function shortDir(dir: string): string {
  if (dir === "~") return "~";
  const parts = dir.replace(/^~\//, "").replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || dir;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export function isPromptLikeShellTitle(title: string): boolean {
  return /(?:^|\s)[^@\s]+@[^%#$\n]+.*\s[%#$](?:\s|$)/.test(title.trim());
}

/**
 * 把 agent 的活动状态映射成侧栏标题里的状态后缀。idle（空闲等待输入）返回
 * undefined，让标题回退到纯 agent 名字——只有「正在动」的状态才值得占标题位。
 * 文案走 i18n（sidebar.agent.activity.*）。这里直接用模块级 t()：deriveTitle
 * 是纯函数拿不到 useT hook，而 t() 读全局已解析语言。调用方需自行订阅语言
 * store 才能在切换时重渲染：SessionCard 是 memo 组件，专门调了一次 useT() 订阅
 * （见 SessionCard.tsx）；Titlebar / CommandPalette 本来就有 useT。
 */
export function agentActivityLabel(activity?: AgentActivity): string | undefined {
  if (activity === "running") return t("sidebar.agent.activity.running");
  if (activity === "starting") return t("sidebar.agent.activity.starting");
  if (activity === "waiting_confirmation") return t("sidebar.agent.activity.waiting_confirmation");
  return undefined;
}

export function deriveTitle(s: Session): { primary: string; subtitle: string; isCommand: boolean; totalAdded: number; totalRemoved: number } {
  let primary: string;
  let isCommand = false;

  const lastCommand = s.lastCommand && !isPromptLikeShellTitle(s.lastCommand)
    ? s.lastCommand
    : undefined;

  // A shellTitle is "meaningful" only if it adds information beyond what the
  // dir already conveys. shellTitleUpdate already dropped agent, agent-name and
  // prompt-like titles, so here we just guard against it collapsing to the dir.
  const hasMeaningfulShellTitle =
    !!s.shellTitle
    && !s.suppressShellTitle
    && !isPromptLikeShellTitle(s.shellTitle)
    && s.shellTitle !== s.dir
    && s.shellTitle !== shortDir(s.dir);

  if (s.customTitle) {
    primary = s.customTitle;
  } else if (s.agent) {
    // Agents (e.g. Claude Code) only report their own name via OSC titles, so we
    // append the live activity from agentActivity instead — "Claude Code · 运行中"
    // when working, just the name when idle.
    const name = AGENT_NAMES[s.agent] ?? s.agent;
    const status = agentActivityLabel(s.agentActivity);
    primary = status ? `${name} · ${status}` : name;
  } else if (lastCommand) {
    primary = truncate(lastCommand, 60);
    isCommand = true;
  } else if (hasMeaningfulShellTitle) {
    primary = s.shellTitle!;
  } else {
    primary = s.title && !isPromptLikeShellTitle(s.title) ? s.title : t("session.default_title");
  }

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

  return { primary, subtitle: parts.join(" · "), isCommand, totalAdded, totalRemoved };
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 按 dir 归组（设计稿侧栏分段） */
export function groupByDir(sessions: Session[]): Record<string, Session[]> {
  const groups = new Map<string, Session[]>();
  for (const session of sessions) {
    const group = groups.get(session.dir) ?? [];
    group.push(session);
    groups.set(session.dir, group);
  }
  return Object.fromEntries(groups);
}
