// Conduit UI 共用类型定义

/** Agent 类型代码（用于侧栏品牌识别） */
export type AgentCode = "CC" | "CX" | "AM" | "GM" | "CP" | "CR" | "DR" | "OC" | "PI" | "AG" | "DV";

/** 会话运行状态 */
export type RunState = "idle" | "running" | "done" | "failed";

/** 会话数据 */
export interface Session {
  id: string;
  agent?: AgentCode;
  title: string;
  dir: string;
  branch: string;

  // ── 生命周期 ──
  runState: RunState;
  startedAt?: number;
  completedAt?: number;
  unread?: boolean;

  // ── 动态标题源（Warp 风格瀑布推导） ──
  lastCommand?: string;
  lastExitCode?: number;
  shellTitle?: string;

  // ── 改动基线：agent 启动时的工作区快照 tree oid，用于「本次改动」范围 diff ──
  agentBaseline?: string;

  pendingInput?: string;

  // ── git 改动 ──
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
  added: number;
  removed: number;
  patch?: string;
}

/** 覆盖层类型 */
export type OverlayType = null | "settings" | "command-palette";

/** 主题 */
export type ThemeType = "light" | "dark" | "system";

/** 终端配色主题 */
export type TerminalThemeName = "default" | "catppuccin" | "tokyo-night" | "one-dark" | "solarized";

export const AGENT_NAMES: Record<string, string> = {
  CC: "Claude Code",
  CX: "Codex",
  AM: "Amp",
  GM: "Gemini",
  CP: "Copilot",
  CR: "Cursor",
  DR: "Droid",
  OC: "OpenCode",
  PI: "Pi",
  AG: "Auggie",
  DV: "Devin",
};

function shortDir(dir: string): string {
  if (dir === "~") return "~";
  const parts = dir.replace(/^~\//, "").replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || dir;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export function deriveTitle(s: Session): { primary: string; subtitle: string; isCommand: boolean } {
  let primary: string;
  let isCommand = false;

  if (s.agent) {
    primary = AGENT_NAMES[s.agent] ?? s.agent;
  } else if (s.lastCommand) {
    primary = truncate(s.lastCommand, 60);
    isCommand = true;
  } else if (s.shellTitle && s.shellTitle !== s.dir && s.shellTitle !== shortDir(s.dir)) {
    primary = s.shellTitle;
  } else {
    primary = s.title || "New session";
  }

  const dirLabel = shortDir(s.dir);
  const parts: string[] = [];
  if (s.branch) parts.push(`⎇ ${s.branch}`);
  parts.push(dirLabel);
  if (s.changes?.files.length) {
    const added = s.changes.files.reduce((a, f) => a + f.added, 0);
    const removed = s.changes.files.reduce((a, f) => a + f.removed, 0);
    const diffParts: string[] = [];
    if (added > 0) diffParts.push(`+${added}`);
    if (removed > 0) diffParts.push(`-${removed}`);
    if (diffParts.length) parts.push(diffParts.join(" "));
  }

  return { primary, subtitle: parts.join(" · "), isCommand };
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
