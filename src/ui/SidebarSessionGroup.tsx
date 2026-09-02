import type { KeyboardEvent, MouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { SessionCard } from "./SessionCard";
import { DirGroupHeader } from "./SidebarDirGroupHeader";
import { buildDirGroupMenuItems } from "./sidebar-dir-group-menu";
import { useSessionsStore } from "@/state/sessions";
import { getNumberRecordValue } from "@/state/record-keys";
import { currentWorkspaceWorktree } from "@/modules/git/workspace-context";
import { isFixedTerminalMenuEvent } from "@/modules/config/keybindings";
import { groupCue } from "@/modules/session/session-attention";
import {
  localDirFromGroup,
  representativeSession,
  sshEndpointLabel,
  sshRemoteFromGroup,
  type SidebarGroup,
} from "@/modules/session/sidebar-groups";
import type { ExternalEditor } from "@/state/ui";
import type { MenuEntry } from "./ContextMenu";
import type { Session } from "./types";

interface SidebarSessionGroupProps {
  group: SidebarGroup;
  collapsed: boolean;
  activeSessionId: string;
  tabbableSessionId: string | null;
  canReorder: boolean;
  drag: { draggingId: string; sourceGroupKey: string; overIndex: number } | null;
  confirmClose: boolean;
  closeConfirmations: Record<string, number>;
  externalEditor: ExternalEditor;
  t: (key: string, params?: Record<string, string | number>) => string;
  onToggleCollapse: () => void;
  onOpenMenu: (items: MenuEntry[], position: { x: number; y: number }) => void;
  onDragStart: (e: ReactPointerEvent, sessionId: string, groupKey: string, index: number) => void;
  onSelect: (id: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLElement>, id: string) => void;
  onClose: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onContextMenu: (e: MouseEvent, session: Session) => void;
}

export function SidebarSessionGroup({
  group,
  collapsed,
  activeSessionId,
  tabbableSessionId,
  canReorder,
  drag,
  confirmClose,
  closeConfirmations,
  externalEditor,
  t,
  onToggleCollapse,
  onOpenMenu,
  onDragStart,
  onSelect,
  onKeyDown,
  onClose,
  onRename,
  onContextMenu,
}: SidebarSessionGroupProps) {
  const { key, kind, sessions: groupSessions } = group;
  const localDir = localDirFromGroup(group);
  const remote = sshRemoteFromGroup(group);
  const workspaceSession = groupSessions.find((session) => session.workspace);
  const workspaceContext = workspaceSession?.workspace;
  const currentWorktree = currentWorkspaceWorktree(workspaceContext);
  const workspace = workspaceContext && currentWorktree
    ? {
        repositoryName: workspaceContext.repository.name,
        worktreeName: currentWorktree.name,
        branch: currentWorktree.branch,
        detached: currentWorktree.detached,
        dirtyFiles: currentWorktree.dirtyFiles,
        ahead: currentWorktree.ahead,
        behind: currentWorktree.behind,
        available: currentWorktree.available,
        transport: workspaceContext.repository.transport,
      }
    : undefined;
  const agentCount = groupSessions.filter((session) => Boolean(session.agent)).length;
  const label = kind === "ssh" && remote
    ? sshEndpointLabel(remote)
    : localDir?.split("/").pop() || localDir || key;
  const pathTitle = kind === "ssh" && remote ? sshEndpointLabel(remote) : localDir || key;
  const representative = representativeSession(groupSessions, activeSessionId);

  return (
    <div style={{ marginBottom: 6 }} data-sidebar-group={key}>
      <DirGroupHeader
        kind={kind}
        label={label}
        pathTitle={pathTitle}
        count={groupSessions.length}
        workspace={workspace}
        agentCount={agentCount}
        cue={groupCue(groupSessions)}
        collapsed={collapsed}
        onToggleCollapse={onToggleCollapse}
        onNewTerminal={kind === "ssh"
          ? (representative ? () => useSessionsStore.getState().duplicateOnHost(representative.id) : undefined)
          : localDir
            ? () => useSessionsStore.getState().newTerminalInDir(localDir)
            : undefined}
        onCloseAll={() => useSessionsStore.getState().closeSessionsInGroup(key)}
        confirmClose={confirmClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onOpenMenu(
            buildDirGroupMenuItems({ groupKey: key, groupSessions, activeSessionId, t, externalEditor }),
            { x: e.clientX, y: e.clientY },
          );
        }}
        onKeyDown={(e) => {
          if (isFixedTerminalMenuEvent(e)) {
            e.preventDefault();
            const rect = e.currentTarget.getBoundingClientRect();
            e.currentTarget.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: rect.left + 8, clientY: rect.bottom }));
          }
        }}
      />
      {!collapsed && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2, animation: "contentIn var(--dur-base) var(--ease-out)" }}>
          {groupSessions.map((s, idx) => {
            const isDragging = drag?.draggingId === s.id;
            const showIndicator = drag?.sourceGroupKey === key && drag.overIndex === idx && drag.draggingId !== s.id;
            return (
              <div key={s.id} data-session-id={s.id} role="listitem">
                {showIndicator && (
                  <div style={{ height: 2, background: "var(--c-accent)", borderRadius: 1, margin: "2px 8px 4px" }} />
                )}
                <div
                  onPointerDown={(e) => {
                    if (!canReorder) return;
                    if (e.pointerType === "touch") return;
                    if ((e.target as HTMLElement).closest(".session-card-close") || (e.target as HTMLElement).closest(".hover-close")) return;
                    onDragStart(e, s.id, key, idx);
                  }}
                  style={{
                    opacity: isDragging ? 0.3 : 1,
                    transition: "opacity var(--dur-fast) var(--ease-out)",
                    touchAction: "pan-y",
                    cursor: !canReorder ? "pointer" : isDragging ? "grabbing" : "grab",
                  }}
                >
                  <SessionCard
                    session={s}
                    active={s.id === activeSessionId}
                    confirmCloseAt={getNumberRecordValue(closeConfirmations, s.id)}
                    tabIndex={s.id === tabbableSessionId ? 0 : -1}
                    onSelect={onSelect}
                    onKeyDown={onKeyDown}
                    onClose={onClose}
                    onRename={onRename}
                    onContextMenu={onContextMenu}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
