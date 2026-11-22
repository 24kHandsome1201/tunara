import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { DiffPanel } from "@/ui/DiffPanel";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import type { Session } from "@/ui/types";
import type { WorkspaceContext } from "@/modules/git/git-bridge";

const session: Session = {
  id: "changes-editor", title: "Terminal", dir: "/project/src", branch: "main",
  runState: "idle", updatedAt: 1, gitState: "repo",
  changes: { files: [{ path: "src/app.ts", stage: "unstaged", status: "M", added: 1, removed: 1 }] },
};
const workspace: WorkspaceContext = {
  repository: { id: "repo", name: "project", commonGitDir: "/project/.git", transport: "local", bare: false },
  currentWorktreeId: "checkout",
  worktrees: [{ id: "checkout", name: "project", path: "/project", detached: false, current: true, locked: false, available: true }],
};

beforeEach(() => {
  useSessionsStore.setState({ sessions: [session], activeSessionId: session.id, gitNonce: {} });
  useUIStore.setState({ readers: {}, toasts: [], externalEditor: "vscode" });
});

test.each(["/project", "/project/src", "/project/src/deep"])("Changes opens repository-relative files from cwd %s", async (dir) => {
  const calls: Array<{ command: string; payload: unknown }> = [];
  mockIPC((command, payload) => {
    calls.push({ command, payload });
    return command === "git_workspace_context" ? workspace : null;
  });
  render(<DiffPanel session={{ ...session, dir }} embedded />);
  fireEvent.click(screen.getByRole("button", { name: "Open in external editor" }));
  await waitFor(() => expect(calls.filter((call) => call.command === "open_in_editor")).toEqual([
    { command: "open_in_editor", payload: { editor: "vscode", path: "/project/src/app.ts" } },
  ]));
  expect(calls).toContainEqual({ command: "git_workspace_context", payload: { repoPath: dir } });
  expect(useUIStore.getState().readers[session.id]).toBeUndefined();
});

test("Changes uses the current linked worktree rather than the main checkout", async () => {
  const calls: unknown[] = [];
  mockIPC((command, payload) => {
    if (command === "open_in_editor") calls.push(payload);
    return command === "git_workspace_context" ? {
      ...workspace,
      currentWorktreeId: "linked",
      worktrees: [...workspace.worktrees.map((worktree) => ({ ...worktree, current: false })),
        { ...workspace.worktrees[0], id: "linked", path: "/linked" }],
    } : null;
  });
  render(<DiffPanel session={{ ...session, dir: "/linked/src" }} embedded />);
  fireEvent.click(screen.getByRole("button", { name: "Open in external editor" }));
  await waitFor(() => expect(calls).toEqual([{ editor: "vscode", path: "/linked/src/app.ts" }]));
});

test.each(["missing checkout", "discovery error"])("Changes does not open an incorrect path on %s", async (failure) => {
  const opens: unknown[] = [];
  mockIPC((command, payload) => {
    if (command === "git_workspace_context") {
      if (failure === "discovery error") throw new Error("repository removed");
      return { ...workspace, worktrees: [] };
    }
    if (command === "open_in_editor") opens.push(payload);
    return null;
  });
  render(<DiffPanel session={session} embedded />);
  fireEvent.click(screen.getByRole("button", { name: "Open in external editor" }));
  await waitFor(() => expect(useUIStore.getState().toasts.slice(-1)[0]?.variant).toBe("error"));
  expect(opens).toEqual([]);
});
