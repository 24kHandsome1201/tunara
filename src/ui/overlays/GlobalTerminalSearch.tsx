import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { deriveTitle, type Session } from "../types";
import { useSessionsStore } from "@/state/sessions";
import { Icon, SearchIcon, Terminal, TerminalWindow } from "@/ui/icons";
import { useT } from "@/modules/i18n";
import { useFocusTrap } from "./useFocusTrap";
import { listTerminalSearchSources, revealTerminalSearchMatch } from "@/modules/terminal/lib/terminal-action-registry";
import {
  buildTerminalSearchSnippet,
  compileTerminalSearch,
  createLatestSearchRunner,
  groupTerminalSearchMatches,
  searchTerminalSources,
  TERMINAL_SEARCH_MAX_RESULTS,
  type TerminalSearchGroup,
  type TerminalSearchResultItem,
  type TerminalSearchSource,
} from "@/modules/terminal/lib/cross-session-search";

// Transient per-run memory so reopening restores the last lookup. Never persisted.
const lastGlobalSearch = { query: "", regex: false, caseSensitive: false };

const SEARCH_DEBOUNCE_MS = 60;

interface SearchState {
  groups: TerminalSearchGroup[];
  total: number;
  truncated: boolean;
  done: boolean;
  error: "invalid-regex" | null;
}

const IDLE_STATE: SearchState = { groups: [], total: 0, truncated: false, done: true, error: null };

function yieldToHost(): Promise<void> {
  if (typeof MessageChannel === "undefined") return new Promise((resolve) => setTimeout(resolve, 0));
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

function orderSources(sources: TerminalSearchSource[], sessions: readonly Session[], activeSessionId: string | null): TerminalSearchSource[] {
  const rank = new Map(sessions.map((session, index) => [session.id, session.id === activeSessionId ? -1 : index]));
  return sources
    .filter((source) => rank.has(source.sessionId))
    .sort((a, b) => (rank.get(a.sessionId) ?? 0) - (rank.get(b.sessionId) ?? 0));
}

const TOGGLE_STYLE: React.CSSProperties = {
  minWidth: 24,
  height: 22,
  padding: "0 5px",
  fontSize: "var(--fs-meta)",
  fontFamily: "var(--font-mono)",
  cursor: "pointer",
  borderRadius: "var(--r-badge-sm)",
  flexShrink: 0,
};

function toggleStyle(active: boolean): React.CSSProperties {
  return {
    ...TOGGLE_STYLE,
    color: active ? "var(--c-accent)" : "var(--c-text-5)",
    background: active ? "var(--c-accent-bg-light)" : "transparent",
    border: active ? "1px solid var(--c-accent-border)" : "1px solid transparent",
  };
}

export function GlobalTerminalSearch({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [query, setQuery] = useState(lastGlobalSearch.query);
  const [regex, setRegex] = useState(lastGlobalSearch.regex);
  const [caseSensitive, setCaseSensitive] = useState(lastGlobalSearch.caseSensitive);
  const [state, setState] = useState<SearchState>(IDLE_STATE);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  const runnerRef = useRef(createLatestSearchRunner());
  useFocusTrap(dialogRef);

  const sessions = useSessionsStore((s) => s.sessions);
  const sessionsById = useMemo(() => new Map(sessions.map((session) => [session.id, session])), [sessions]);

  useEffect(() => {
    lastGlobalSearch.query = query;
    lastGlobalSearch.regex = regex;
    lastGlobalSearch.caseSensitive = caseSensitive;
    const runner = runnerRef.current;
    const run = runner.begin();
    const compiled = compileTerminalSearch(query, { regex, caseSensitive });
    if (!compiled.ok) {
      setState(compiled.reason === "invalid-regex" ? { ...IDLE_STATE, error: "invalid-regex" } : IDLE_STATE);
      return () => runner.cancel();
    }
    setState((previous) => ({ ...previous, done: false, error: null }));
    const timer = setTimeout(() => {
      if (run.isCancelled()) return;
      const { sessions: currentSessions, activeSessionId: currentActive } = useSessionsStore.getState();
      const sources = orderSources(listTerminalSearchSources(), currentSessions, currentActive);
      void searchTerminalSources(sources, compiled.find, {
        isCancelled: run.isCancelled,
        yieldToHost,
        onProgress: (snapshot) => {
          if (run.isCancelled()) return;
          setState({
            groups: groupTerminalSearchMatches(snapshot.matches, sources),
            total: snapshot.matches.length,
            truncated: snapshot.truncated,
            done: snapshot.done,
            error: null,
          });
        },
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      runner.cancel();
    };
  }, [query, regex, caseSensitive]);

  const flat = useMemo(() => state.groups.flatMap((group) => group.matches), [state.groups]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query, regex, caseSensitive]);

  useEffect(() => {
    setSelectedIndex((index) => (flat.length === 0 ? 0 : Math.min(index, flat.length - 1)));
  }, [flat.length]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const selected = listRef.current?.querySelector<HTMLElement>(`[data-result-index="${selectedIndex}"]`);
    selected?.scrollIntoView?.({ block: "nearest" });
  }, [selectedIndex]);

  const choose = (item: TerminalSearchResultItem | undefined) => {
    if (!item) return;
    onClose();
    revealTerminalSearchMatch(item.sessionId, item.row, item.start, item.end);
  };

  function handleKeyDown(e: React.KeyboardEvent) {
    if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (flat.length > 0) setSelectedIndex((i) => Math.min(i + 1, flat.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(flat[selectedIndex]);
    }
  }

  const sessionLabel = (sessionId: string) => {
    const session = sessionsById.get(sessionId);
    if (!session) return { title: sessionId, detail: "" };
    const { primary } = deriveTitle(session);
    const detail = session.remote ? `${session.remote.user}@${session.remote.host}` : session.dir;
    return { title: primary, detail };
  };

  const statusText = state.error === "invalid-regex"
    ? t("terminal_search.invalid_regex")
    : !query
      ? t("terminal_search.hint")
      : !state.done && state.total === 0
        ? t("terminal_search.searching")
        : state.total === 0
          ? t("terminal_search.no_results")
          : state.truncated
            ? t("terminal_search.summary_capped", { count: state.total, sessions: state.groups.length, max: TERMINAL_SEARCH_MAX_RESULTS })
            : t("terminal_search.summary", { count: state.total, sessions: state.groups.length });

  let flatIndex = 0;

  return (
    <>
      <div
        aria-hidden="true"
        onClick={onClose}
        className="overlay-backdrop"
        style={{ position: "fixed", inset: 0, zIndex: 999, background: "var(--backdrop-color)" }}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("terminal_search.title")}
        onKeyDown={handleKeyDown}
        className="overlay-palette"
        style={{
          position: "fixed",
          top: "var(--palette-top)",
          left: "50%",
          transform: "translateX(-50%)",
          width: "min(720px, 90vw)",
          maxHeight: "70vh",
          background: "var(--c-bg-white)",
          border: "1px solid var(--c-control-border)",
          borderRadius: "var(--r-overlay)",
          boxShadow: "var(--shadow-overlay)",
          zIndex: 1000,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--c-border-1)", display: "flex", alignItems: "center", gap: 8 }}>
          <SearchIcon size={14} color={state.error ? "var(--c-error)" : undefined} />
          <input
            className="ui-control"
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="terminal-search-listbox"
            aria-activedescendant={flat.length > 0 ? `terminal-search-option-${selectedIndex}` : undefined}
            aria-autocomplete="list"
            aria-invalid={state.error ? true : undefined}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={(e) => {
              composingRef.current = false;
              setQuery((e.target as HTMLInputElement).value);
            }}
            aria-label={t("terminal_search.placeholder")}
            placeholder={t("terminal_search.placeholder")}
            spellCheck={false}
            style={{
              flex: 1,
              border: "none",
              background: "transparent",
              outline: "none",
              fontSize: "var(--fs-body)",
              color: "var(--c-text-primary)",
              fontFamily: "var(--font-ui)",
            }}
          />
          <button
            type="button"
            className="hover-bg"
            aria-pressed={regex}
            title={t("term.search.regex")}
            aria-label={t("term.search.regex")}
            onClick={() => setRegex((value) => !value)}
            style={toggleStyle(regex)}
          >
            .*
          </button>
          <button
            type="button"
            className="hover-bg"
            aria-pressed={caseSensitive}
            title={t("term.search.case_sensitive")}
            aria-label={t("term.search.case_sensitive")}
            onClick={() => setCaseSensitive((value) => !value)}
            style={toggleStyle(caseSensitive)}
          >
            Aa
          </button>
        </div>
        <div
          role="status"
          aria-live="polite"
          aria-atomic="true"
          style={{
            padding: "6px 16px",
            fontSize: "var(--fs-meta)",
            color: state.error ? "var(--c-error)" : "var(--c-text-5)",
            borderBottom: flat.length > 0 ? "1px solid var(--c-border-1)" : undefined,
          }}
        >
          {statusText}
        </div>
        <div
          ref={listRef}
          role="listbox"
          id="terminal-search-listbox"
          aria-label={t("terminal_search.title")}
          style={{ flex: 1, overflowY: "auto", padding: flat.length > 0 ? "6px 0" : 0 }}
          className="no-scrollbar scroll-fade-y"
        >
          {state.groups.map((group) => {
            const label = sessionLabel(group.sessionId);
            const remote = Boolean(sessionsById.get(group.sessionId)?.remote);
            return (
              <div key={group.sessionId} role="group" aria-label={label.title}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 16px 4px", fontSize: "var(--fs-meta)", color: "var(--c-text-4)", fontWeight: 700, minWidth: 0 }}>
                  <Icon icon={remote ? TerminalWindow : Terminal} size={12} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label.title}</span>
                  {label.detail && (
                    <span style={{ fontWeight: 400, color: "var(--c-text-5)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                      {label.detail}
                    </span>
                  )}
                  <span style={{ marginLeft: "auto", fontWeight: 400, color: "var(--c-text-5)", flexShrink: 0 }}>{group.matches.length}</span>
                </div>
                {group.matches.map((item) => {
                  const index = flatIndex++;
                  const selected = index === selectedIndex;
                  const snippet = buildTerminalSearchSnippet(item.text, item);
                  return (
                    <div
                      key={`${item.sessionId}:${item.row}`}
                      role="option"
                      id={`terminal-search-option-${index}`}
                      aria-selected={selected}
                      data-result-index={index}
                      onClick={() => choose(item)}
                      onMouseEnter={() => setSelectedIndex(index)}
                      style={{
                        display: "flex",
                        flexDirection: "column",
                        gap: 1,
                        padding: "5px 14px",
                        margin: "0 6px",
                        cursor: "pointer",
                        borderRadius: "var(--r-btn)",
                        background: selected ? "var(--c-accent-bg-light)" : "transparent",
                        transition: "background var(--dur-fast) var(--ease-out)",
                        minWidth: 0,
                      }}
                    >
                      <div style={{ display: "flex", gap: 10, alignItems: "baseline", minWidth: 0 }}>
                        <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)", flexShrink: 0, minWidth: 44, textAlign: "right" }}>
                          {t("terminal_search.line", { line: item.row + 1 })}
                        </span>
                        <span style={{ fontSize: "var(--fs-secondary)", fontFamily: "var(--font-mono)", color: "var(--c-text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "pre", minWidth: 0 }}>
                          {snippet.before}
                          <mark style={{ background: "var(--c-accent-bg-light)", color: "var(--c-accent)", borderRadius: 2, fontWeight: 600 }}>{snippet.match}</mark>
                          {snippet.after}
                        </span>
                      </div>
                      {item.command && (
                        <div style={{ paddingLeft: 54, fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {t("terminal_search.block", { command: item.command })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
