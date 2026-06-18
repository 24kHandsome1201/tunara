// Conduit UI 共用类型定义

/** Agent 类型：CC=Claude Code, CX=Codex, CU=Cursor(暂不支持) */
export type AgentType = "CC" | "CX" | "CU";

/** 会话状态 */
export type SessionStatus = "running" | "fresh" | "done";

/** 会话数据 */
export interface Session {
  id: string;
  title: string;
  dir: string;
  branch: string;
  agent: AgentType;
  status: SessionStatus;
  duration: string;
  /** 运行中进度(0-100)，仅 running 时有意义 */
  progress?: number;
  /** 改动文件列表 */
  changedFiles?: ChangedFile[];
  /** 改动摘要，如"3 文件 · +26 −6" */
  diffSummary?: string;
  /** 建议的 commit 信息 */
  commitMsg?: string;
}

/** diff 面板中的改动文件 */
export interface ChangedFile {
  path: string;
  /** M=修改 A=新增 D=删除 R=重命名 */
  status: "M" | "A" | "D" | "R";
  added: number;
  removed: number;
  /** mini diff 内容（首个文件展开） */
  patch?: string;
}

/** 覆盖层类型 */
export type OverlayType = null | "agent" | "settings";

/** 主题 */
export type ThemeType = "light" | "dark" | "system";

/** 通知项 */
export interface Notification {
  id: string;
  /** 失败=红持久, 完成=绿 */
  type: "error" | "success";
  message: string;
  sessionTitle?: string;
}

/** UI 全局状态 */
export interface UIState {
  activeSessionId: string;
  sidebarVisible: boolean;
  panelVisible: boolean;
  overlay: OverlayType;
  notifOpen: boolean;
  agentPick: AgentType;
  theme: ThemeType;
}
