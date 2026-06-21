// Conduit UI 共用类型定义
import { AGENT_NAMES } from "../modules/agent/registry.ts";
export { AGENT_NAMES };

/** Agent 类型代码（用于侧栏品牌识别） */
export type AgentCode = "CC" | "CX" | "AM" | "GM" | "CP" | "CR" | "DR" | "OC" | "PI" | "AG" | "DV";

/** 会话运行状态 */
export type RunState = "idle" | "running" | "done" | "failed";

/** Agent 进程内的活动状态，独立于普通 shell 命令状态 */
export type AgentActivity = "starting" | "idle" | "running";

/** Git 探测状态 */
export type GitState = "unknown" | "repo" | "notGit";

/** 会话数据 */
export interface Session {
  id: string;
  agent?: AgentCode;
  agentActivity?: AgentActivity;
  title: string;
  dir: string;
  branch: string;

  // ── 生命周期 ──
  runState: RunState;
  startedAt?: number;
  completedAt?: number;
  unread?: boolean;

  // ── 用户自定义标题（优先级最高） ──
  customTitle?: string;

  // ── 动态标题源（Warp 风格瀑布推导） ──
  lastCommand?: string;
  lastExitCode?: number;
  shellTitle?: string;
  suppressShellTitle?: boolean;

  pendingInput?: string;

  // ── git 改动 ──
  gitState?: GitState;
  changes?: {
    files: ChangedFile[];
    summary: string;
    commit?: string;
  };

  updatedAt: number;
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
export type OverlayType = null | "settings" | "command-palette";

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

export function deriveTitle(s: Session): { primary: string; subtitle: string; isCommand: boolean; totalAdded: number; totalRemoved: number } {
  let primary: string;
  let isCommand = false;

  const lastCommand = s.lastCommand && !isPromptLikeShellTitle(s.lastCommand)
    ? s.lastCommand
    : undefined;

  if (s.customTitle) {
    primary = s.customTitle;
  } else if (s.agent) {
    primary = AGENT_NAMES[s.agent] ?? s.agent;
  } else if (lastCommand) {
    primary = truncate(lastCommand, 60);
    isCommand = true;
  } else if (
    s.shellTitle
    && !s.suppressShellTitle
    && !isPromptLikeShellTitle(s.shellTitle)
    && s.shellTitle !== s.dir
    && s.shellTitle !== shortDir(s.dir)
  ) {
    primary = s.shellTitle;
  } else {
    primary = s.title && !isPromptLikeShellTitle(s.title) ? s.title : "终端";
  }

  const dirLabel = shortDir(s.dir);
  const parts: string[] = [];
  if (s.branch) parts.push(`⎇ ${s.branch}`);
  parts.push(dirLabel);
  let totalAdded = 0;
  let totalRemoved = 0;
  if (s.changes?.files.length) {
    for (const file of s.changes.files) {
      totalAdded += file.added;
      totalRemoved += file.removed;
    }
  }

  if (s.changes?.files.length) {
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
  return sessions.reduce<Record<string, Session[]>>((acc, s) => {
    (acc[s.dir] ??= []).push(s);
    return acc;
  }, {});
}
