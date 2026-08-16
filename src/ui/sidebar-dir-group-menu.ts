import { openInEditorWithToast } from "./lib/open-in-editor";
import { copyText } from "./lib/clipboard";
import { canUseSessionDirForLocalTerminal } from "@/modules/session/local-terminal-cwd";
import {
  knownRemoteCwd,
  representativeSession,
  sshEndpointLabel,
} from "@/modules/session/sidebar-groups";
import { useSessionsStore } from "@/state/sessions";
import type { ExternalEditor } from "@/state/ui";
import type { MenuEntry } from "./ContextMenu";
import type { Session } from "./types";

interface BuildDirGroupMenuOptions {
  groupKey: string;
  groupSessions: readonly Session[];
  activeSessionId: string;
  t: (key: string, params?: Record<string, string | number>) => string;
  externalEditor: ExternalEditor;
}

export function dirGroupHasLocalFilesystem(groupSessions: readonly Pick<Session, "remote">[]): boolean {
  return groupSessions.some(canUseSessionDirForLocalTerminal);
}

export function buildDirGroupMenuItems({
  groupKey,
  groupSessions,
  activeSessionId,
  t,
  externalEditor,
}: BuildDirGroupMenuOptions): MenuEntry[] {
  const remote = groupSessions.find((session) => session.remote)?.remote;
  if (remote) {
    const representative = representativeSession(groupSessions, activeSessionId);
    const cwd = groupSessions.map((session) => knownRemoteCwd(session.dir)).find((path): path is string => Boolean(path));
    return [
      ...(representative
        ? [{ id: "dir:duplicate-host", label: t("sidebar.session.duplicate_host"), icon: "ssh" as const, action: () => { useSessionsStore.getState().duplicateOnHost(representative.id); } }]
        : []),
      { id: "dir:copy-remote", label: t("sidebar.session.copy_remote"), icon: "copy", action: () => { void copyText(sshEndpointLabel(remote)); } },
      ...(cwd
        ? [{ id: "dir:copy-cwd", label: t("sidebar.session.copy_remote_cwd"), icon: "copy" as const, action: () => { void copyText(cwd); } }]
        : []),
      null,
      { id: "dir:close-all", label: t("sidebar.dir.close_all"), icon: "close", danger: true, action: () => useSessionsStore.getState().closeSessionsInGroup(groupKey) },
    ];
  }

  const dir = groupSessions[0]?.dir ?? "";
  const localDirItems: MenuEntry[] = dirGroupHasLocalFilesystem(groupSessions)
    ? [
        { id: "dir:new-terminal", label: t("sidebar.dir.new_terminal"), icon: "terminal", action: () => useSessionsStore.getState().newTerminalInDir(dir) },
        { id: "dir:open-editor", label: t("sidebar.dir.open_in_editor"), icon: "editor", action: () => { void openInEditorWithToast(externalEditor, dir); } },
      ]
    : [];

  return [
    ...localDirItems,
    { id: "dir:copy-path", label: t("sidebar.dir.copy_path"), icon: "copy", action: () => { void copyText(dir); } },
    null,
    { id: "dir:close-all", label: t("sidebar.dir.close_all"), icon: "close", danger: true, action: () => useSessionsStore.getState().closeSessionsInGroup(groupKey) },
  ];
}
