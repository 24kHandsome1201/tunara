import { useSessionsStore } from "@/state/sessions";
import { useUIStore, type ExternalEditor } from "@/state/ui";
import { openInEditor } from "@/modules/editor/open";
import { copyText } from "./lib/clipboard";
import type { MenuEntry } from "./ContextMenu";
import type { Session } from "./types";

interface BuildSessionMenuOptions {
  session: Session;
  t: (key: string, params?: Record<string, string | number>) => string;
  externalEditor: ExternalEditor;
  onSelectSession: (id: string) => void;
  onCloseSession?: (id: string) => void;
}

export function buildSessionMenuItems({
  session,
  t,
  externalEditor,
  onSelectSession,
  onCloseSession,
}: BuildSessionMenuOptions): MenuEntry[] {
  const openNotes = () => {
    onSelectSession(session.id);
    const ui = useUIStore.getState();
    ui.setPanelVisible(true);
    ui.setInspectorTab("notes");
  };
  const items: MenuEntry[] = [
    { id: "session:pin", label: session.pinned ? t("sidebar.session.unpin") : t("sidebar.session.pin"), icon: "pin", action: () => { useSessionsStore.getState().togglePinnedSession(session.id); } },
    { id: "session:notes", label: t("sidebar.session.open_notes"), icon: "note", action: openNotes },
    { id: "session:rename", label: t("sidebar.session.rename"), icon: "rename", action: () => { useSessionsStore.getState().startRenaming(session.id); } },
  ];
  if (!session.remote) {
    items.push({ id: "session:open-editor", label: t("sidebar.session.open_in_editor"), icon: "editor", action: () => { openInEditor(externalEditor, session.dir).catch(() => {}); } });
  }
  items.push(
    { id: "session:copy-dir", label: session.remote ? t("sidebar.session.copy_remote") : t("sidebar.session.copy_dir"), icon: "copy", action: () => { void copyText(session.dir); } },
    null,
    { id: "session:close", label: t("sidebar.session.close"), icon: "close", danger: true, action: () => { onCloseSession?.(session.id); } },
  );
  return items;
}
