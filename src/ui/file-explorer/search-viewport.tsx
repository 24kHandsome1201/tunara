import { useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";

interface SearchViewportRow {
  key: string;
  height: number;
  focusable: boolean;
}

export interface SearchViewportHandle {
  focusFirst: () => boolean;
}

interface SearchViewportProps<Row extends SearchViewportRow> {
  ref: Ref<SearchViewportHandle>;
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
  const headerRef = useRef<HTMLDivElement>(null);
  const rowsRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 0, inset: 0 });
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [pendingIndex, setPendingIndex] = useState<number | null>(null);
  const { offsets, indexesByKey } = useMemo(() => {
    const offsets = [0];
    const indexesByKey = new Map<string, number>();
    rows.forEach((row, index) => {
      offsets.push(offsets[index] + row.height);
      indexesByKey.set(row.key, index);
    });
    return { offsets, indexesByKey };
  }, [rows]);

  function measure(viewport: HTMLDivElement) {
    const top = viewport.scrollTop;
    const height = viewport.clientHeight;
    const inset = rowsRef.current?.offsetTop ?? 0;
    setView((current) => current.top === top && current.height === height && current.inset === inset
      ? current
      : { top, height, inset });
  }

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const header = headerRef.current;
    if (!viewport || !header) return;
    const update = () => measure(viewport);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(viewport);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  function focusRow(index: number) {
    const viewport = viewportRef.current;
    if (!viewport || !rows[index]?.focusable) return false;
    const inset = rowsRef.current?.offsetTop ?? 0;
    const rowTop = offsets[index] + inset;
    const rowBottom = offsets[index + 1] + inset;
    if (rowTop < viewport.scrollTop) viewport.scrollTop = rowTop;
    else if (rowBottom > viewport.scrollTop + viewport.clientHeight) {
      viewport.scrollTop = Math.min(rowTop, rowBottom - viewport.clientHeight);
    }
    measure(viewport);
    const button = getButton(viewport, index);
    if (button) button.focus({ preventScroll: true });
    else setPendingIndex(index);
    return true;
  }

  useImperativeHandle(ref, () => ({ focusFirst: () => focusRow(rows.findIndex((row) => row.focusable)) }));

  useLayoutEffect(() => {
    if (pendingIndex === null) return;
    getButton(viewportRef.current, pendingIndex)?.focus({ preventScroll: true });
    setPendingIndex(null);
  }, [pendingIndex]);

  const top = view.top - view.inset;
  const first = rowAt(offsets, top - OVERSCAN);
  const last = Math.min(rows.length, rowAt(offsets, top + view.height + OVERSCAN) + 1);
  const mounted = new Set(Array.from({ length: last - first }, (_, index) => first + index));
  const focusedIndex = focusedKey === null ? undefined : indexesByKey.get(focusedKey);
  if (focusedIndex !== undefined) mounted.add(focusedIndex);
  if (pendingIndex !== null && pendingIndex < rows.length) mounted.add(pendingIndex);

  return (
    <div
      ref={viewportRef}
      className="no-scrollbar scroll-fade-y"
      style={{ flex: 1, minHeight: 0, position: "relative", overflowY: "auto", overscrollBehavior: "contain", overflowAnchor: "none", padding: "6px var(--sp-2)" }}
      onScroll={(event) => measure(event.currentTarget)}
      onFocus={(event) => {
        const index = (event.target as HTMLElement).closest<HTMLElement>("[data-search-row]")?.dataset.searchRow;
        setFocusedKey(index === undefined ? null : rows[Number(index)]?.key ?? null);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusedKey(null);
      }}
      onKeyDown={(event) => {
        const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
        if (!step || focusedIndex === undefined) return;
        event.preventDefault();
        for (let index = focusedIndex + step; index >= 0 && index < rows.length; index += step) {
          if (focusRow(index)) return;
        }
      }}
    >
      <div ref={headerRef}>{header}</div>
      <div ref={rowsRef} style={{ position: "relative", height: offsets[rows.length] }}>
        {[...mounted].sort((a, b) => a - b).map((index) => (
          <div key={rows[index].key} data-search-row={index} style={{ position: "absolute", top: offsets[index], insetInline: 0 }}>
            {renderRow(rows[index])}
          </div>
        ))}
      </div>
      {footer}
    </div>
  );
}

function getButton(viewport: HTMLDivElement | null, index: number) {
  return viewport?.querySelector<HTMLButtonElement>(`[data-search-row="${index}"] > button`);
}
