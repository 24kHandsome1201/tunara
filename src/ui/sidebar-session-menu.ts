import { useSessionsStore } from "@/state/sessions";
import { useUIStore, type ExternalEditor } from "@/state/ui";
import { openInEditorWithToast } from "./lib/open-in-editor";
import { copyText } from "./lib/clipboard";
import type { MenuEntry } from "./ContextMenu";
import type { Session } from "./types";

interface BuildSessionMenuOptions {
  session: Session;
  t: (key: string, params?: Record<string, string | number>) => string;
  externalEditor: ExternalEditor;
  onSelectSession: (id: string) => void;
  onCloseSession?: (id: string) => void;
  groupSessions?: Session[];
  canReorder?: boolean;
  onReordered?: (position: number) => void;
}

export function buildSessionMenuItems({
  session,
  t,
  externalEditor,
  onSelectSession,
  onCloseSession,
  groupSessions = [],
  canReorder = true,
  onReordered,
}: BuildSessionMenuOptions): MenuEntry[] {
  const groupIndex = groupSessions.findIndex((candidate) => candidate.id === session.id);
  const move = (delta: -1 | 1) => {
    const next = groupIndex + delta;
    useSessionsStore.getState().reorderInGroup(session.dir, groupIndex, next);
    onReordered?.(next + 1);
  };
  const openNotes = () => {
    onSelectSession(session.id);
    const ui = useUIStore.getState();
    ui.setPanelVisible(true);
    ui.setInspectorTab("notes");
  };
  const chooseMascot = () => {
    onSelectSession(session.id);
    const ui = useUIStore.getState();
    ui.setPanelVisible(true);
    ui.setInspectorTab("overview");
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const picker = document.querySelector<HTMLElement>(`[data-session-mascot-picker="${session.id}"]`);
      picker?.scrollIntoView({ block: "nearest" });
      picker?.querySelector<HTMLButtonElement>("button[aria-pressed='true']")?.focus();
    }));
  };
  const items: MenuEntry[] = [
    { id: "session:pin", label: session.pinned ? t("sidebar.session.unpin") : t("sidebar.session.pin"), icon: "pin", action: () => { useSessionsStore.getState().togglePinnedSession(session.id); } },
    { id: "session:mascot", label: t("sidebar.session.choose_mascot"), icon: "mascot", action: chooseMascot },
    { id: "session:notes", label: t("sidebar.session.open_notes"), icon: "note", action: openNotes },
    ...(session.remote ? [{ id: "session:duplicate", label: t("sidebar.session.duplicate_host"), icon: "ssh" as const, action: () => { useSessionsStore.getState().duplicateOnHost(session.id); } }] : []),
    { id: "session:rename", label: t("sidebar.session.rename"), icon: "rename", action: () => { useSessionsStore.getState().startRenaming(session.id); } },
    { id: "session:move-up", label: t("sidebar.session.move_up"), disabled: !canReorder || groupIndex <= 0, action: () => move(-1) },
    { id: "session:move-down", label: t("sidebar.session.move_down"), disabled: !canReorder || groupIndex < 0 || groupIndex >= groupSessions.length - 1, action: () => move(1) },
  ];
  if (!session.remote) {
    items.push({ id: "session:open-editor", label: t("sidebar.session.open_in_editor"), icon: "editor", action: () => { void openInEditorWithToast(externalEditor, session.dir, { sessionId: session.id }); } });
  }
  items.push(
    { id: "session:copy-dir", label: session.remote ? t("sidebar.session.copy_remote") : t("sidebar.session.copy_dir"), icon: "copy", action: () => { void copyText(session.dir); } },
    null,
    { id: "session:close", label: t("sidebar.session.close"), icon: "close", danger: true, action: () => { onCloseSession?.(session.id); } },
  );
  return items;
}
