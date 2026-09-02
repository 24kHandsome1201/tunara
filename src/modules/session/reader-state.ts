export const READER_HISTORY_LIMIT = 10;

export interface ReaderFileRef {
  filePath: string;
  fileName: string;
  line?: number;
  column?: number;
}

export interface SessionReaderState {
  current: ReaderFileRef | null;
  history: ReaderFileRef[];
  historyIndex: number;
  dirty: boolean;
}

export function emptyReaderState(): SessionReaderState {
  return { current: null, history: [], historyIndex: -1, dirty: false };
}

function isSafeRecordKey(key: string): boolean {
  return key.length > 0 && key !== "__proto__" && key !== "prototype" && key !== "constructor";
}

function sanitizeFileName(filePath: string, fileName: unknown): string {
  if (typeof fileName === "string" && fileName.trim()) return fileName;
  return filePath.split("/").filter(Boolean).pop() ?? filePath;
}

export function sanitizeReaderFileRef(raw: unknown): ReaderFileRef | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.filePath !== "string" || !value.filePath || /[\0\r\n]/.test(value.filePath)) return null;
  const line = typeof value.line === "number" && Number.isFinite(value.line) && value.line > 0
    ? Math.trunc(value.line)
    : undefined;
  const column = typeof value.column === "number" && Number.isFinite(value.column) && value.column > 0
    ? Math.trunc(value.column)
    : undefined;
  return {
    filePath: value.filePath,
    fileName: sanitizeFileName(value.filePath, value.fileName),
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
  };
}

function sameReaderPath(a: ReaderFileRef | null | undefined, b: ReaderFileRef | null | undefined): boolean {
  return Boolean(a && b && a.filePath === b.filePath);
}

function withLocation(file: ReaderFileRef, location: Pick<ReaderFileRef, "line" | "column">): ReaderFileRef {
  return {
    filePath: file.filePath,
    fileName: file.fileName,
    ...(location.line !== undefined ? { line: location.line } : {}),
    ...(location.column !== undefined ? { column: location.column } : {}),
  };
}

function capHistory(history: ReaderFileRef[], historyIndex: number): { history: ReaderFileRef[]; historyIndex: number } {
  if (history.length <= READER_HISTORY_LIMIT) return { history, historyIndex };
  const overflow = history.length - READER_HISTORY_LIMIT;
  return {
    history: history.slice(overflow),
    historyIndex: Math.max(0, historyIndex - overflow),
  };
}

export function openReaderFileInState(
  state: SessionReaderState | undefined,
  file: ReaderFileRef,
): SessionReaderState {
  const current = state ?? emptyReaderState();
  if (sameReaderPath(current.current, file)) {
    return {
      ...current,
      current: withLocation(file, file),
      history: current.history.map((entry, index) =>
        index === current.historyIndex ? withLocation(entry, file) : entry),
    };
  }

  const truncated = current.history.slice(0, current.historyIndex + 1)
    .filter((entry) => entry.filePath !== file.filePath);
  truncated.push(withLocation(file, file));
  const capped = capHistory(truncated, truncated.length - 1);
  return {
    current: withLocation(file, file),
    history: capped.history,
    historyIndex: capped.historyIndex,
    dirty: false,
  };
}

export function readerHistoryBack(state: SessionReaderState): SessionReaderState {
  if (state.historyIndex <= 0) return state;
  const historyIndex = state.historyIndex - 1;
  return { ...state, historyIndex, current: state.history[historyIndex] ?? state.current, dirty: false };
}

export function readerHistoryForward(state: SessionReaderState): SessionReaderState {
  if (state.historyIndex < 0 || state.historyIndex >= state.history.length - 1) return state;
  const historyIndex = state.historyIndex + 1;
  return { ...state, historyIndex, current: state.history[historyIndex] ?? state.current, dirty: false };
}

export function readerSelectHistoryIndex(state: SessionReaderState, index: number): SessionReaderState {
  const entry = state.history[index];
  if (!entry) return state;
  return { ...state, historyIndex: index, current: entry, dirty: false };
}

export function sanitizeSessionReaderState(raw: unknown): SessionReaderState | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const historyRaw = Array.isArray(value.history) ? value.history : [];
  const history: ReaderFileRef[] = [];
  const seen = new Set<string>();
  for (const item of historyRaw) {
    const file = sanitizeReaderFileRef(item);
    if (!file || seen.has(file.filePath)) continue;
    seen.add(file.filePath);
    history.push(file);
    if (history.length >= READER_HISTORY_LIMIT) break;
  }
  const current = sanitizeReaderFileRef(value.current);
  let historyIndex = typeof value.historyIndex === "number" && Number.isFinite(value.historyIndex)
    ? Math.trunc(value.historyIndex)
    : -1;
  if (current && !history.some((entry) => entry.filePath === current.filePath)) {
    history.push(current);
  }
  if (current) {
    const currentIndex = history.findIndex((entry) => entry.filePath === current.filePath);
    historyIndex = currentIndex >= 0 ? currentIndex : history.length - 1;
  } else if (historyIndex < 0 || historyIndex >= history.length) {
    historyIndex = history.length - 1;
  }
  const capped = capHistory(history, historyIndex);
  return {
    current: current ?? capped.history[capped.historyIndex] ?? null,
    history: capped.history,
    historyIndex: capped.history.length === 0 ? -1 : capped.historyIndex,
    dirty: false,
  };
}

export function sanitizeReaders(
  raw: unknown,
  validSessionIds: ReadonlySet<string>,
): Record<string, SessionReaderState> {
  const out: Record<string, SessionReaderState> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [sessionId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isSafeRecordKey(sessionId) || !validSessionIds.has(sessionId)) continue;
    const reader = sanitizeSessionReaderState(value);
    if (reader) out[sessionId] = reader;
  }
  return out;
}

interface LegacyFileTab {
  sessionId: string;
  filePath: string;
  fileName: string;
  line?: number;
  column?: number;
  id?: string;
}

function sanitizeLegacyFileTab(raw: unknown): LegacyFileTab | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.sessionId !== "string" || !isSafeRecordKey(value.sessionId)) return null;
  const file = sanitizeReaderFileRef(value);
  if (!file) return null;
  return {
    sessionId: value.sessionId,
    ...file,
    ...(typeof value.id === "string" ? { id: value.id } : {}),
  };
}

/** Old file-tab snapshots: each session's active tab becomes current, the rest become history. */
export function migrateFileTabsToReaders(
  fileTabsRaw: unknown,
  activeFileTabId: unknown,
  validSessionIds: ReadonlySet<string>,
): Record<string, SessionReaderState> {
  if (!Array.isArray(fileTabsRaw)) return {};
  const tabs = fileTabsRaw.map(sanitizeLegacyFileTab).filter((tab): tab is LegacyFileTab => Boolean(tab));
  const bySession = new Map<string, LegacyFileTab[]>();
  for (const tab of tabs) {
    if (!validSessionIds.has(tab.sessionId)) continue;
    const list = bySession.get(tab.sessionId) ?? [];
    list.push(tab);
    bySession.set(tab.sessionId, list);
  }

  const activeId = typeof activeFileTabId === "string" ? activeFileTabId : null;
  const out: Record<string, SessionReaderState> = {};
  for (const [sessionId, sessionTabs] of bySession) {
    const activeIndex = activeId
      ? sessionTabs.findIndex((tab) => tab.id === activeId || `${tab.sessionId}\0${tab.filePath}` === activeId)
      : -1;
    const currentTab = activeIndex >= 0 ? sessionTabs[activeIndex] : sessionTabs[sessionTabs.length - 1];
    if (!currentTab) continue;
    let state = emptyReaderState();
    for (const tab of sessionTabs) {
      state = openReaderFileInState(state, tab);
    }
    if (currentTab) state = openReaderFileInState(state, currentTab);
    out[sessionId] = state;
  }
  return out;
}

export function persistableReaders(
  readers: Record<string, SessionReaderState>,
): Record<string, Omit<SessionReaderState, "dirty">> {
  const out: Record<string, Omit<SessionReaderState, "dirty">> = {};
  for (const [sessionId, reader] of Object.entries(readers)) {
    if (!isSafeRecordKey(sessionId)) continue;
    if (!reader.current && reader.history.length === 0) continue;
    out[sessionId] = {
      current: reader.current,
      history: reader.history,
      historyIndex: reader.historyIndex,
    };
  }
  return out;
}
