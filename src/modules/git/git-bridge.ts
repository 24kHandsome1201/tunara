// Git 前端桥（实施文档 §4.3 / §3.4）
//
// invoke 封装：git_status / git_diff / git_ahead_behind。
// 与后端 git/mod.rs + git/commit.rs 的命令契约对齐。

import { invoke } from "@tauri-apps/api/core";

export interface FileChange {
  path: string;
  status: string;
  added: number;
  removed: number;
}

export interface StatusResult {
  branch: string;
  files: FileChange[];
  summary: string;
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

export function gitStatus(repoPath: string, baseline?: string): Promise<StatusResult> {
  return invoke<StatusResult>("git_status", { repoPath, baseline: baseline ?? null });
}

export function gitDiff(repoPath: string, file: string, baseline?: string): Promise<FileDiff> {
  return invoke<FileDiff>("git_diff", { repoPath, file, baseline: baseline ?? null });
}

export function gitAheadBehind(repoPath: string): Promise<RemoteState> {
  return invoke<RemoteState>("git_ahead_behind", { repoPath });
}

/** agent 启动时抓一个工作区基线快照，返回 tree oid，用于「本次改动」范围 diff。 */
export function gitSnapshotBaseline(repoPath: string): Promise<string> {
  return invoke<string>("git_snapshot_baseline", { repoPath });
}
