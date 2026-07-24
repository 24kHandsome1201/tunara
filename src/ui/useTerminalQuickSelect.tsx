import { useCallback, useEffect, useState, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { openInEditor } from "@/modules/editor/open";
import { collectTerminalQuickSelectItems, TERMINAL_QUICK_SELECT_EVENT, type TerminalQuickSelectItem } from "@/modules/terminal/lib/terminal-quick-select";
import { terminalQuickSelectRange } from "@/modules/terminal/lib/terminal-quick-select-scope";
import { useUIStore } from "@/state/ui";
import { useT } from "@/modules/i18n";
import { copyText } from "./lib/clipboard";
import { TerminalQuickSelect } from "./TerminalQuickSelect";

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
      notify(t("quick_select.empty.title"), t("quick_select.empty.body"), "error");
      return;
    }
    setItems(next);
  }, [active, cwd, notify, t, termRef]);

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
    setItems(null);
    termRef.current?.focus();
  }, [termRef]);

  const copyItem = useCallback((item: TerminalQuickSelectItem) => {
    void copyText(item.copyText).then((ok) => {
      if (ok) {
        notify(t("quick_select.copied.title"), item.copyText, "success");
        setItems(null);
      } else {
        notify(t("quick_select.copy_failed.title"), item.label, "error");
      }
    });
  }, [notify, t]);

  const openItem = useCallback((item: TerminalQuickSelectItem) => {
    if (item.kind === "text") {
      copyItem(item);
      return;
    }
    const run = item.kind === "url"
      ? openUrl(item.target)
      : openInEditor(useUIStore.getState().externalEditor, item.target, item.line, item.column);
    run
      .then(() => setItems(null))
      .catch(() => notify(t("quick_select.open_failed.title"), item.label, "error"));
  }, [copyItem, notify, t]);

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
