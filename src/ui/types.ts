// Conduit UI 共用类型定义（M3：加入事实字段 + agent 事件契约）

/** Agent 类型 */
export type AgentCode = "CC" | "CX" | "AM" | "GM" | "CP" | "CR" | "DR" | "OC" | "PI" | "AG" | "DV";

export type AgentType = AgentCode;

/** 会话类别：shell=真实终端, agent=AI agent */
export type SessionKind = "shell" | "agent";

/**
 * 运行态事实字段（§4.2 终态持久化 修 P2-16）。
 * store 存事实，UI 派生 fresh/done：
 *   fresh = runState==='completed' && Date.now()-completedAt < FRESH_WINDOW && unread
 */
export type RunState =
  | "idle"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timeout";

/** UI 展示用的状态（由事实字段派生） */
export type SessionStatus = "running" | "fresh" | "done" | "failed";

/** 内联块：少量结构（toolUse/fileChange/轮次分隔）。正文 delta 不进数组，见 reply */
export type AgentBlock =
  | { type: "toolUse"; name: string; summary?: string }
  | { type: "fileChange"; path: string }
  | { type: "turn" };

/** 改动文件（与后端 git FileChange 对齐） */
export interface ChangedFile {
  path: string;
  /** M=修改 A=新增 D=删除 R=重命名 */
  status: string;
  added: number;
  removed: number;
  /** mini diff 内容 */
  patch?: string;
}

/** 会话数据（M3：事实字段 + 向后兼容 M2 UI 组件） */
export interface Session {
  id: string;
  kind: SessionKind;
  agent?: AgentCode;
  agentSessionId?: string; // CC=session_id / CX=thread_id（多轮 resume）
  procId?: number; // 后端 agent_spawn / pty_open 返回的 id
  title: string;
  dir: string;
  branch: string;
  /** 创建会话时的初始 prompt（agent 会话头部展示用） */
  prompt?: string;

  // ── 事实字段（store 持久化，UI 派生 status） ──
  runState: RunState;
  startedAt?: number;
  completedAt?: number;
  unread?: boolean;

  // ── 内容 ──
  reply: string; // 打字机正文（仅追加）
  blocks: AgentBlock[]; // 少量块结构
  result?: string;
  error?: string;
  costUsd?: number;
  updatedAt: number;

  // ── 动态标题源（Warp 风格瀑布推导） ──
  lastCommand?: string;
  shellTitle?: string;

  // ── git 改动 ──
  changes?: {
    files: ChangedFile[];
    summary: string;
    commit?: string;
  };

}

/** Agent 事件契约（与后端 AgentEvent camelCase 对齐，§4.3） */
export type AgentEvent =
  | { kind: "started"; agentSessionId?: string }
  | { kind: "delta"; text: string }
  | { kind: "toolUse"; name: string; summary?: string }
  | { kind: "fileChange"; path: string }
  | { kind: "done"; ok: boolean; result?: string; costUsd?: number }
  | { kind: "failed"; message: string };

/** 覆盖层类型 */
export type OverlayType = null | "agent" | "settings";

/** 主题 */
export type ThemeType = "light" | "dark" | "system";

/** 通知项 */
export interface Notification {
  id: string;
  type: "error" | "success";
  message: string;
  sessionTitle?: string;
  /** 点击通知跳转到的会话 */
  sessionId?: string;
}

/** 从事实字段派生 UI 状态 */
const FRESH_WINDOW = 30_000; // 30s 内"刚完成"

export function deriveStatus(s: Session): SessionStatus {
  switch (s.runState) {
    case "running":
      return "running";
    case "failed":
    case "cancelled":
    case "timeout":
      return "failed";
    case "completed":
      if (s.unread && s.completedAt && Date.now() - s.completedAt < FRESH_WINDOW) {
        return "fresh";
      }
      return "done";
    default:
      return "done";
  }
}

/** 从事实字段派生会话耗时文案（侧栏卡片展示用） */
export function deriveDuration(s: Session): string {
  const end = s.runState === "running" ? Date.now() : s.completedAt;
  if (!s.startedAt || !end) return "";
  const sec = Math.max(0, Math.round((end - s.startedAt) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h${min % 60}m`;
}

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

  if (s.kind === "agent") {
    if (s.prompt) {
      primary = truncate(s.prompt.replace(/\n/g, " ").trim(), 60);
    } else {
      primary = s.agent ? (AGENT_NAMES[s.agent] ?? s.agent) : "Agent";
    }
  } else {
    if (s.runState === "running" && s.lastCommand) {
      primary = s.lastCommand;
      isCommand = true;
    } else if (s.shellTitle && s.shellTitle !== s.dir && s.shellTitle !== shortDir(s.dir)) {
      primary = s.shellTitle;
    } else if (s.lastCommand) {
      primary = s.lastCommand;
      isCommand = true;
    } else {
      primary = s.title || "New session";
    }
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

/** 按 dir 归组（设计稿侧栏分段） */
export function groupByDir(sessions: Session[]): Record<string, Session[]> {
  return sessions.reduce<Record<string, Session[]>>((acc, s) => {
    (acc[s.dir] ??= []).push(s);
    return acc;
  }, {});
}
