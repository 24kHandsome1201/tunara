import { useCallback, useEffect, useState, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { openResource, resourceRefForSession } from "@/modules/resources/resource-ref";
import { useSessionsStore } from "@/state/sessions";
import { collectTerminalQuickSelectItems, TERMINAL_QUICK_SELECT_EVENT, type TerminalQuickSelectItem } from "@/modules/terminal/lib/terminal-quick-select";
import { terminalQuickSelectRange } from "@/modules/terminal/lib/terminal-quick-select-scope";
import { useUIStore } from "@/state/ui";
import { useT } from "@/modules/i18n";
import { copyText } from "./lib/clipboard";
import { TerminalQuickSelect } from "./TerminalQuickSelect";
import { issueFocusReturnToken, runBindingAwareContinuation } from "@/modules/terminal/lib/binding-aware-async-action";

interface TerminalQuickSelectOptions {
  active: boolean;
  cwd: string;
  sessionId: string;
}

function readQuickSelectTerminalLines(term: Terminal): string[] {
  const buffer = term.buffer.active;
  const { start, end } = terminalQuickSelectRange(buffer.length, buffer.viewportY, term.rows);
  const lines: string[] = [];
  for (let row = start; row <= end; row += 1) {
    const line = buffer.getLine(row);
    if (line) lines.push(line.translateToString(true));
  }
  return lines;
}

export function useTerminalQuickSelect(
  termRef: RefObject<Terminal | null>,
  { active, cwd, sessionId }: TerminalQuickSelectOptions,
) {
  const [items, setItems] = useState<TerminalQuickSelectItem[] | null>(null);
  const t = useT();
  const presentationMode = useUIStore((s) => s.presentationMode);

  const notify = useCallback((title: string, subtitle: string, variant: "success" | "error") => {
    useUIStore.getState().addToast({ sessionId, title, subtitle, variant });
  }, [sessionId]);

  const openQuickSelect = useCallback(() => {
    if (useUIStore.getState().presentationMode === "pure") return;
    if (!active) return;
    const term = termRef.current;
    if (!term) return;
    const next = collectTerminalQuickSelectItems(readQuickSelectTerminalLines(term), cwd);
    if (next.length === 0) {
      return;
    }
    setItems(next);
  }, [active, cwd, termRef]);

  useEffect(() => {
    const onQuickSelect = () => openQuickSelect();
    window.addEventListener(TERMINAL_QUICK_SELECT_EVENT, onQuickSelect);
    return () => window.removeEventListener(TERMINAL_QUICK_SELECT_EVENT, onQuickSelect);
  }, [openQuickSelect]);

  useEffect(() => {
    if (!active) setItems(null);
  }, [active]);

  useEffect(() => {
    if (presentationMode === "pure") setItems(null);
  }, [presentationMode]);

  const closeQuickSelect = useCallback(() => {
    const token = issueFocusReturnToken(sessionId);
    setItems(null);
    if (token) runBindingAwareContinuation(token, () => termRef.current?.focus());
  }, [sessionId, termRef]);

  const copyItem = useCallback((item: TerminalQuickSelectItem) => {
    const token = issueFocusReturnToken(sessionId);
    void copyText(item.copyText).then((ok) => {
      if (!token || !runBindingAwareContinuation(token, () => {})) return;
      if (ok) {
        notify(t("quick_select.copied.title"), item.copyText, "success");
        setItems(null);
      } else {
        notify(t("quick_select.copy_failed.title"), item.label, "error");
      }
      runBindingAwareContinuation(token, () => termRef.current?.focus());
    });
  }, [notify, sessionId, t, termRef]);

  const openItem = useCallback((item: TerminalQuickSelectItem) => {
    if (item.kind === "text") {
      copyItem(item);
      return;
    }
    const token = issueFocusReturnToken(sessionId);
    const owner = useSessionsStore.getState().sessions.find((session) => session.id === sessionId);
    const run = item.kind === "url"
      ? openUrl(item.target)
      : owner
        ? openResource(resourceRefForSession(owner, item.target, item.line, item.column))
        : Promise.reject(new Error("missing resource owner"));
    run
      .then(() => { if (token) runBindingAwareContinuation(token, () => setItems(null)); })
      .catch(() => { if (token) runBindingAwareContinuation(token, () => notify(t("quick_select.open_failed.title"), item.label, "error")); })
      .finally(() => { if (token) runBindingAwareContinuation(token, () => termRef.current?.focus()); });
  }, [copyItem, notify, sessionId, t, termRef]);

  return {
    openQuickSelect,
    quickSelectOverlay: items ? (
      <TerminalQuickSelect
        items={items}
        onClose={closeQuickSelect}
        onCopy={copyItem}
        onOpen={openItem}
      />
    ) : null,
  };
}
