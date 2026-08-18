// Git 前端桥（实施文档 §4.3 / §3.4）
//
// invoke 封装：git_status / git_diff / git_ahead_behind。
// 与后端 git/mod.rs 的只读 IPC 契约对齐；commit.rs 仅是 Rust 测试 fixture。

import { invoke } from "@tauri-apps/api/core";
import type { SessionBindingV1 } from "@/modules/terminal/lib/pty-bridge";

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

export interface RepositoryRef {
  id: string;
  name: string;
  commonGitDir: string;
  transport: "local" | "ssh";
  host?: string;
  bare: boolean;
}

export interface WorktreeRef {
  id: string;
  name: string;
  path: string;
  branch?: string;
  head?: string;
  detached: boolean;
  dirtyFiles?: number;
  upstream?: string;
  ahead?: number;
  behind?: number;
  current: boolean;
  locked: boolean;
  available: boolean;
  error?: string;
}

export interface WorkspaceContext {
  repository: RepositoryRef;
  currentWorktreeId?: string;
  worktrees: WorktreeRef[];
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

export function gitWorkspaceContext(repoPath: string): Promise<WorkspaceContext> {
  return invoke<WorkspaceContext>("git_workspace_context", { repoPath });
}

export function gitWatch(repoPath: string): Promise<void> {
  return invoke<void>("git_watch", { repoPath });
}

export function gitUnwatch(repoPath: string): Promise<void> {
  return invoke<void>("git_unwatch", { repoPath });
}

// ── Remote git (over an SSH exec channel) ─────────────────────────────────
// Diff and workspace discovery keep their specialized read-only commands;
// aggregate status/upstream refreshes use sshRemoteGitSnapshotV1 below.

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

export function sshGitWorkspaceContext(
  sessionId: number,
  cwd: string,
  repositoryKey: string,
  requestId: string,
): Promise<WorkspaceContext> {
  return invoke<WorkspaceContext>("ssh_git_workspace_context", { sessionId, cwd, repositoryKey, requestId });
}

export function cancelGitRequest(requestId: string): Promise<boolean> {
  return invoke<boolean>("fs_cancel_search", { requestId });
}

export type RemoteGitErrorKind = "notRepository" | "transportUnavailable" | "timeout" | "permissionDenied" | "gitUnavailable" | "pathUnavailable" | "cancelled" | "unknown";
export interface RemoteGitErrorV1 { kind: RemoteGitErrorKind; retryable: boolean }
export interface RemoteGitSnapshotV1 {
  requestId: string; generation: number; binding: SessionBindingV1; observedAt: number;
  freshness: "fresh" | "stale";
  repo?: { status: StatusResult; upstream: RemoteState; workspace?: WorkspaceContext };
  unavailableFields: Array<{ field: "workspace"; kind: RemoteGitErrorKind }>;
  error?: RemoteGitErrorV1;
}

export function sshRemoteGitSnapshotV1(request: {
  requestId: string; generation: number; binding: SessionBindingV1; cwd: string; repositoryKey: string; force: boolean;
}): Promise<RemoteGitSnapshotV1> {
  return invoke<RemoteGitSnapshotV1>("ssh_remote_git_snapshot_v1", { request });
}

export function cancelRemoteGitSnapshot(requestId: string): Promise<boolean> {
  return invoke<boolean>("cancel_operation_v1", { request: { domain: "remoteGit", requestId } });
}
