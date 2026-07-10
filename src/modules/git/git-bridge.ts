// Git 前端桥（实施文档 §4.3 / §3.4）
//
// invoke 封装：git_status / git_diff / git_ahead_behind。
// 与后端 git/mod.rs 的只读 IPC 契约对齐；commit.rs 仅是 Rust 测试 fixture。

import { invoke } from "@tauri-apps/api/core";

export interface FileChange {
  path: string;
  status: string;
  stage: "staged" | "unstaged" | "untracked";
  added: number;
  removed: number;
}

export interface StatusResult {
  branch: string;
  files: FileChange[];
}

export type FileDiff =
  | { kind: "text"; path: string; patch: string; truncated: boolean; totalLines: number }
  | { kind: "binary"; path: string }
  | { kind: "tooLarge"; path: string; bytes: number }
  | { kind: "metadataOnly"; path: string; change: string };

export type RemoteState =
  | { state: "ok"; upstream: string; ahead: number; behind: number }
  | { state: "noUpstream"; branch: string }
  | { state: "detached"; oid: string }
  | { state: "unborn" }
  | { state: "unknown"; message: string };

export function gitStatus(repoPath: string): Promise<StatusResult> {
  return invoke<StatusResult>("git_status", { repoPath });
}

export function gitDiff(repoPath: string, file: string, stage: FileChange["stage"]): Promise<FileDiff> {
  return invoke<FileDiff>("git_diff", { repoPath, file, stage });
}

export function gitAheadBehind(repoPath: string): Promise<RemoteState> {
  return invoke<RemoteState>("git_ahead_behind", { repoPath });
}

export function gitWatch(repoPath: string): Promise<void> {
  return invoke<void>("git_watch", { repoPath });
}

export function gitUnwatch(repoPath: string): Promise<void> {
  return invoke<void>("git_unwatch", { repoPath });
}

// ── Remote git (over an SSH exec channel) ─────────────────────────────────
// Mirror the local git_status/git_diff contract so DiffPanel can render a
// remote repo without caring about the transport. `sessionId` is the
// SshSession's pty id (the same u32 PtyState id the terminal uses).

export function sshGitStatus(sessionId: number, cwd: string): Promise<StatusResult> {
  return invoke<StatusResult>("ssh_git_status", { sessionId, cwd });
}

export function sshGitDiff(
  sessionId: number,
  cwd: string,
  file: string,
  stage: FileChange["stage"],
  requestId: string,
): Promise<FileDiff> {
  return invoke<FileDiff>("ssh_git_diff", { sessionId, cwd, file, stage, requestId });
}

export function cancelGitDiff(requestId: string): Promise<boolean> {
  return invoke<boolean>("fs_cancel_search", { requestId });
}

export function sshGitAheadBehind(sessionId: number, cwd: string): Promise<RemoteState> {
  return invoke<RemoteState>("ssh_git_ahead_behind", { sessionId, cwd });
}
