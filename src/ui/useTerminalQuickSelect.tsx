import { useCallback, useEffect, useState, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { openInEditor } from "@/modules/editor/open";
import { collectTerminalQuickSelectItems, TERMINAL_QUICK_SELECT_EVENT, type TerminalQuickSelectItem } from "@/modules/terminal/lib/terminal-quick-select";
import { terminalQuickSelectRange } from "@/modules/terminal/lib/terminal-quick-select-scope";
import { useUIStore } from "@/state/ui";
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

  const notify = useCallback((title: string, subtitle: string, variant: "success" | "error") => {
    useUIStore.getState().addToast({ sessionId, title, subtitle, variant });
  }, [sessionId]);

  const openQuickSelect = useCallback(() => {
    if (!active) return;
    const term = termRef.current;
    if (!term) return;
    const next = collectTerminalQuickSelectItems(readQuickSelectTerminalLines(term), cwd);
    if (next.length === 0) {
      notify("没有可快速选择的内容", "附近输出里没有 URL、文件位置或可复制标识", "error");
      return;
    }
    setItems(next);
  }, [active, cwd, notify, termRef]);

  useEffect(() => {
    const onQuickSelect = () => openQuickSelect();
    window.addEventListener(TERMINAL_QUICK_SELECT_EVENT, onQuickSelect);
    return () => window.removeEventListener(TERMINAL_QUICK_SELECT_EVENT, onQuickSelect);
  }, [openQuickSelect]);

  useEffect(() => {
    if (!active) setItems(null);
  }, [active]);

  const closeQuickSelect = useCallback(() => setItems(null), []);

  const copyItem = useCallback((item: TerminalQuickSelectItem) => {
    navigator.clipboard.writeText(item.copyText)
      .then(() => {
        notify("已复制", item.copyText, "success");
        setItems(null);
      })
      .catch(() => notify("复制失败", item.label, "error"));
  }, [notify]);

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
      .catch(() => notify("打开失败", item.label, "error"));
  }, [copyItem, notify]);

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
