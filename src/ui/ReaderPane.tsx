import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties } from "react";
import { useT } from "@/modules/i18n";
import { requestDirtyDraftFileAction } from "@/modules/editor/dirty-draft-guard";
import { openInEditorWithToast } from "./lib/open-in-editor";
import { openRemoteInExternalEditor } from "@/modules/ssh/remote-external-edit";
import { resourceRefForSession } from "@/modules/resources/resource-ref";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { ContextMenu, type MenuEntry } from "./ContextMenu";
import { PanelLoadingState } from "./shared";
import { FileIcon } from "./file-explorer/icons";
import { fileKindTint } from "./file-explorer/file-kind";
import type { Session } from "./types";

const FilePreview = lazy(() => import("./FilePreview").then((module) => ({ default: module.FilePreview })));

interface ReaderPaneProps {
  session: Session;
  active: boolean;
}

const HEADER_BUTTON: CSSProperties = {
  width: 26,
  height: 26,
  borderRadius: "var(--r-btn)",
  border: "none",
  background: "transparent",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
  color: "var(--c-text-4)",
};

export function ReaderPane({ session, active }: ReaderPaneProps) {
  const t = useT();
  const reader = useUIStore((s) => s.readers[session.id]);
  const current = reader?.current ?? null;
  const history = reader?.history ?? [];
  const historyIndex = reader?.historyIndex ?? -1;
  const dirty = reader?.dirty ?? false;
  const canBack = historyIndex > 0;
  const canForward = historyIndex >= 0 && historyIndex < history.length - 1;
  const [historyMenu, setHistoryMenu] = useState<{ items: MenuEntry[]; position: { x: number; y: number } } | null>(null);
  const [overflowMenu, setOverflowMenu] = useState<{ items: MenuEntry[]; position: { x: number; y: number } } | null>(null);
  const historyBtnRef = useRef<HTMLButtonElement>(null);
  const overflowBtnRef = useRef<HTMLButtonElement>(null);
  const [findNonce, setFindNonce] = useState(0);

  useEffect(() => {
    if (!active) return;
    const onFind = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string }>).detail;
      if (detail?.sessionId && detail.sessionId !== session.id) return;
      setFindNonce((value) => value + 1);
    };
    window.addEventListener("tunara:reader-find", onFind);
    return () => window.removeEventListener("tunara:reader-find", onFind);
  }, [active, session.id]);

  if (!current) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--c-text-5)", fontSize: "var(--fs-secondary)" }}>
        {t("reader.empty")}
      </div>
    );
  }

  const closeReader = () => {
    const run = () => useUIStore.getState().closeReaderPane(session.id);
    if (requestDirtyDraftFileAction(session.id, current.filePath, run)) run();
  };

  const openHistoryMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setHistoryMenu({
      position: { x: rect.left, y: rect.bottom },
      items: history.map((entry, index) => ({
        id: `${entry.filePath}:${index}`,
        label: entry.fileName + (reader?.current?.filePath === entry.filePath && dirty && index === historyIndex ? " •" : ""),
        action: () => {
          const go = () => useUIStore.getState().selectReaderHistory(session.id, index);
          if (index !== historyIndex && dirty) {
            if (requestDirtyDraftFileAction(session.id, current.filePath, go)) go();
            return;
          }
          go();
        },
      })),
    });
  };

  const openOverflowMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const items: MenuEntry[] = session.remote
      ? [{
          id: "external-remote",
          label: t("preview.editor.external_remote"),
          action: () => {
            const binding = session.ptyId !== undefined && session.transportGeneration
              ? { logicalSessionId: session.id, physicalPtyId: session.ptyId, transportGeneration: session.transportGeneration }
              : null;
            if (!binding) return;
            void openRemoteInExternalEditor({
              sessionId: session.id,
              binding,
              remotePath: current.filePath,
              editor: useUIStore.getState().externalEditor,
            }).catch(() => {
              useUIStore.getState().addToast({
                sessionId: session.id,
                title: t("preview.editor.external_remote"),
                subtitle: t("preview.editor.external_remote_open_failed"),
                variant: "error",
              });
            });
          },
        }]
      : [{
          id: "external",
          label: t("preview.editor.external"),
          action: () => { void openInEditorWithToast(useUIStore.getState().externalEditor, current.filePath); },
        }];
    setOverflowMenu({ position: { x: rect.right, y: rect.bottom }, items });
  };

  return (
    <div
      data-reader-session-id={session.id}
      style={{ position: "relative", flex: 1, display: "flex", flexDirection: "column", minHeight: 0, minWidth: 0, background: "var(--c-bg-white)" }}
    >
      <div
        style={{
          height: 36,
          borderBottom: "1px solid var(--c-border-1)",
          background: "var(--c-bg-1)",
          display: "flex",
          alignItems: "center",
          gap: 2,
          padding: "0 6px",
          flexShrink: 0,
        }}
      >
        <button
          type="button"
          className="hover-bg"
          disabled={!canBack}
          title={t("reader.back")}
          aria-label={t("reader.back")}
          onClick={() => {
            const go = () => useUIStore.getState().readerHistoryBack(session.id);
            if (dirty && requestDirtyDraftFileAction(session.id, current.filePath, go)) go();
            else if (!dirty) go();
          }}
          style={{ ...HEADER_BUTTON, opacity: canBack ? 1 : 0.35, cursor: canBack ? "pointer" : "default" }}
        >
          ‹
        </button>
        <button
          type="button"
          className="hover-bg"
          disabled={!canForward}
          title={t("reader.forward")}
          aria-label={t("reader.forward")}
          onClick={() => {
            const go = () => useUIStore.getState().readerHistoryForward(session.id);
            if (dirty && requestDirtyDraftFileAction(session.id, current.filePath, go)) go();
            else if (!dirty) go();
          }}
          style={{ ...HEADER_BUTTON, opacity: canForward ? 1 : 0.35, cursor: canForward ? "pointer" : "default" }}
        >
          ›
        </button>
        <button
          ref={historyBtnRef}
          type="button"
          className="hover-bg"
          title={current.filePath}
          aria-label={t("reader.history")}
          aria-haspopup="menu"
          aria-expanded={historyMenu !== null}
          onClick={openHistoryMenu}
          style={{
            minWidth: 0,
            flex: 1,
            height: 26,
            padding: "0 8px",
            border: "none",
            background: "transparent",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 6,
            borderRadius: "var(--r-btn)",
          }}
        >
          <FileIcon className="reader-file-icon" tint={fileKindTint(current.fileName)} />
          <span style={{
            fontSize: "var(--fs-secondary)",
            fontWeight: 600,
            color: "var(--c-text-primary)",
            fontFamily: "var(--font-mono)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}>
            {current.fileName}
          </span>
          {dirty ? <span className="reader-dirty-marker" aria-hidden="true">●</span> : null}
          <span aria-hidden="true" style={{ color: "var(--c-text-5)", fontSize: "var(--fs-meta)", flexShrink: 0 }}>▾</span>
        </button>
        <button
          ref={overflowBtnRef}
          type="button"
          className="hover-bg"
          title={t("common.more_actions")}
          aria-label={t("common.more_actions")}
          aria-haspopup="menu"
          onClick={openOverflowMenu}
          style={HEADER_BUTTON}
        >
          <span aria-hidden="true" style={{ fontSize: 13, letterSpacing: -1 }}>⋯</span>
        </button>
        <button
          type="button"
          className="hover-bg"
          title={t("common.close")}
          aria-label={t("common.close")}
          onClick={closeReader}
          style={HEADER_BUTTON}
        >
          ✕
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
        <Suspense fallback={<PanelLoadingState label={t("preview.reading")} />}>
          <FilePreview
            active={active}
            sessionId={session.id}
            filePath={current.filePath}
            fileName={current.fileName}
            resource={resourceRefForSession(session, current.filePath, current.line, current.column)}
            remotePtyId={session.remote ? session.ptyId : undefined}
            remote={Boolean(session.remote)}
            onClose={closeReader}
            onDirtyChange={(nextDirty) => useUIStore.getState().setReaderDirty(session.id, nextDirty)}
            onNeedsAttention={() => {
              useSessionsStore.getState().setActive(session.id);
              useUIStore.getState().setFocusedPaneId(`reader:${session.id}`);
            }}
            fill
            embedded
            findRequest={findNonce}
          />
        </Suspense>
      </div>
      {historyMenu && (
        <ContextMenu
          items={historyMenu.items}
          position={historyMenu.position}
          onClose={() => setHistoryMenu(null)}
          returnFocusToken={historyBtnRef}
        />
      )}
      {overflowMenu && (
        <ContextMenu
          items={overflowMenu.items}
          position={overflowMenu.position}
          onClose={() => setOverflowMenu(null)}
          returnFocusToken={overflowBtnRef}
        />
      )}
    </div>
  );
}
