import { openInEditor } from "@/modules/editor/open";
import { copyText } from "./lib/clipboard";
import { canUseSessionDirForLocalTerminal } from "@/modules/session/local-terminal-cwd";
import { useSessionsStore } from "@/state/sessions";
import type { ExternalEditor } from "@/state/ui";
import type { MenuEntry } from "./ContextMenu";
import type { Session } from "./types";

interface BuildDirGroupMenuOptions {
  dir: string;
  groupSessions: readonly Pick<Session, "remote">[];
  t: (key: string, params?: Record<string, string | number>) => string;
  externalEditor: ExternalEditor;
}

export function dirGroupHasLocalFilesystem(groupSessions: readonly Pick<Session, "remote">[]): boolean {
  return groupSessions.some(canUseSessionDirForLocalTerminal);
}

export function buildDirGroupMenuItems({
  dir,
  groupSessions,
  t,
  externalEditor,
}: BuildDirGroupMenuOptions): MenuEntry[] {
  const localDirItems: MenuEntry[] = dirGroupHasLocalFilesystem(groupSessions)
    ? [
        { id: "dir:new-terminal", label: t("sidebar.dir.new_terminal"), icon: "terminal", action: () => useSessionsStore.getState().newTerminalInDir(dir) },
        { id: "dir:open-editor", label: t("sidebar.dir.open_in_editor"), icon: "editor", action: () => { openInEditor(externalEditor, dir).catch(() => {}); } },
      ]
    : [];

  return [
    ...localDirItems,
    { id: "dir:copy-path", label: t("sidebar.dir.copy_path"), icon: "copy", action: () => { void copyText(dir); } },
    null,
    { id: "dir:close-all", label: t("sidebar.dir.close_all"), icon: "close", danger: true, action: () => useSessionsStore.getState().closeSessionsInDir(dir) },
  ];
}
