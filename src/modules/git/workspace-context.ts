import type { StatusResult, WorkspaceContext, WorktreeRef } from "./git-bridge";

export function currentWorkspaceWorktree(workspace?: WorkspaceContext): WorktreeRef | undefined {
  if (!workspace) return undefined;
  return workspace.worktrees.find((worktree) => worktree.id === workspace.currentWorktreeId)
    ?? workspace.worktrees.find((worktree) => worktree.current);
}

export function withCurrentDirtyFiles(
  workspace: WorkspaceContext,
  status: StatusResult,
): WorkspaceContext {
  const dirtyFiles = new Set(status.files.map((file) => file.path)).size;
  return {
    ...workspace,
    worktrees: workspace.worktrees.map((worktree) =>
      worktree.id === workspace.currentWorktreeId || worktree.current
        ? { ...worktree, dirtyFiles }
        : worktree,
    ),
  };
}
