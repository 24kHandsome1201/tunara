import { useImperativeHandle, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { flushSync } from "react-dom";
import { mountedTreeRowIndexes } from "./tree-virtual";
import { useExplorerViewport } from "./use-explorer-viewport";

interface SearchViewportRow {
  key: string;
  height: number;
  focusable: boolean;
}

interface SearchViewportProps<Row extends SearchViewportRow> {
  ref: Ref<() => boolean>;
  rows: readonly Row[];
  renderRow: (row: Row) => ReactNode;
  header: ReactNode;
  footer?: ReactNode;
}

const OVERSCAN = 160;

function rowAt(offsets: number[], position: number): number {
  let first = 0;
  let last = offsets.length - 1;
  while (first < last) {
    const middle = Math.floor((first + last) / 2);
    if (offsets[middle + 1] <= position) first = middle + 1;
    else last = middle;
  }
  return first;
}

export function SearchViewport<Row extends SearchViewportRow>({ ref, rows, renderRow, header, footer }: SearchViewportProps<Row>) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const { view, measure } = useExplorerViewport(viewportRef, undefined, rowsRef);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const offsets = useMemo(() => {
    const offsets = [0];
    rows.forEach((row, index) => offsets.push(offsets[index] + row.height));
    return offsets;
  }, [rows]);
  const focusedIndex = useMemo(() => rows.findIndex((row) => row.key === focusedKey), [rows, focusedKey]);

  function focusRow(index: number) {
    const viewport = viewportRef.current;
    if (!viewport || !rows[index]?.focusable) return false;
    const inset = rowsRef.current?.offsetTop ?? 0;
    const rowTop = offsets[index] + inset;
    const rowBottom = offsets[index + 1] + inset;
    viewport.scrollTop = Math.min(rowTop, Math.max(viewport.scrollTop, rowBottom - viewport.clientHeight));
    const selector = `[data-search-row="${index}"] > button`;
    if (!viewport.querySelector(selector)) flushSync(measure);
    viewport.querySelector<HTMLButtonElement>(selector)?.focus({ preventScroll: true });
    return true;
  }

  useImperativeHandle(ref, () => () => focusRow(rows.findIndex((row) => row.focusable)));

  const first = rowAt(offsets, view.top - OVERSCAN);
  const last = rowAt(offsets, view.top + view.height + OVERSCAN) + 1;
  const mounted = mountedTreeRowIndexes(rows.length, { first, last }, [focusedIndex]);

  return (
    <div
      ref={viewportRef}
      className="explorer-search-viewport no-scrollbar scroll-fade-y"
      style={{ overscrollBehavior: "contain" }}
      onScroll={measure}
      onKeyDown={(event) => {
        const tab = event.key === "Tab";
        const step = tab ? (event.shiftKey ? -1 : 1) : event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
        if (!step || focusedIndex < 0) return;
        for (let index = focusedIndex + step; index >= 0 && index < rows.length; index += step) {
          if (focusRow(index)) {
            event.preventDefault();
            return;
          }
        }
        if (!tab) event.preventDefault();
      }}
    >
      <div>{header}</div>
      <div ref={rowsRef} className="explorer-search-rows" style={{ height: offsets[rows.length] }}>
        {mounted.map((index) => (
          <div
            key={rows[index].key}
            data-search-row={index}
            style={{ top: offsets[index] }}
            onFocus={() => setFocusedKey(rows[index].key)}
            onBlur={() => setFocusedKey(null)}
          >
            {renderRow(rows[index])}
          </div>
        ))}
      </div>
      {footer}
    </div>
  );
}
