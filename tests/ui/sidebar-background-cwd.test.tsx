import { mockIPC } from "@tauri-apps/api/mocks";
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";

import type { WorkspaceContext } from "@/modules/git/git-bridge";
import { groupSessionsForSidebar } from "@/modules/session/sidebar-groups";
import { useSessionsStore } from "@/state/sessions";
import { SidebarSessionGroup } from "@/ui/SidebarSessionGroup";
import type { Session } from "@/ui/types";
import { useWorkspaceHydration } from "@/ui/useWorkspaceHydration";

function workspace(name: string): WorkspaceContext {
  return {
    repository: { id: name, name, commonGitDir: `/work/${name}/.git`, transport: "local", bare: false },
    currentWorktreeId: name,
    worktrees: [{ id: name, name, path: `/work/${name}`, branch: "main", detached: false, current: true, locked: false, available: true }],
  };
}

function session(id: string, title: string, patch: Partial<Session> = {}): Session {
  return { id, title, dir: "/work/alpha", branch: "main", runState: "idle", updatedAt: 1, ...patch };
}

function Sidebar() {
  const sessions = useSessionsStore((state) => state.sessions);
  const activeSessionId = "active";
  useWorkspaceHydration(sessions, activeSessionId);
  return (
    <>
      {groupSessionsForSidebar(sessions).map((group) => (
        <SidebarSessionGroup
          key={group.key}
          group={group}
          collapsed={false}
          activeSessionId={activeSessionId}
          tabbableSessionId={activeSessionId}
          canReorder={false}
          drag={null}
          confirmCloseAt={0}
          closeConfirmations={{}}
          externalEditor="vscode"
          t={(key) => key}
          onToggleCollapse={() => {}}
          onOpenMenu={() => {}}
          onDragStart={() => {}}
          onSelect={() => {}}
          onKeyDown={() => {}}
          onClose={() => {}}
          onRename={() => {}}
          onContextMenu={() => {}}
        />
      ))}
    </>
  );
}

/** Group text starts with its project name, then the `└ branch` line. */
function groupHeader(dir: string): HTMLElement {
  return document.querySelector(`[data-sidebar-group="local:${dir}"]`) as HTMLElement;
}

beforeEach(() => {
  mockIPC((command, payload) => {
    if (command === "git_workspace_context") {
      const repoPath = (payload as { repoPath: string }).repoPath;
      return workspace(repoPath.split("/").pop()!);
    }
    return null;
  });
  useSessionsStore.setState({
    activeSessionId: "active",
    sessions: [
      session("active", "Terminal 1", { workspace: workspace("alpha"), workspaceState: "ready" }),
      session("background", "Terminal 2", { workspace: workspace("alpha"), workspaceState: "ready" }),
    ],
  });
});

test("a background terminal that cds into another repository shows that repository in the sidebar", async () => {
  render(<Sidebar />);
  expect(screen.getByText("Terminal 2")).toBeTruthy();

  act(() => useSessionsStore.getState().handleCwdChange("background", "/work/beta"));

  await waitFor(() => expect(groupHeader("/work/beta").textContent).toMatch(/^beta└main/));
  expect(groupHeader("/work/alpha").textContent).toMatch(/^alpha└main/);
});
