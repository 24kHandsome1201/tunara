import { useCallback, useRef, useState } from "react";
import { SearchAddon } from "@xterm/addon-search";
import { getSearchDecorations } from "@/styles/terminalTheme";
import { useUIStore } from "@/state/ui";
import { bindingAwareAsyncAction, issueFocusReturnToken } from "@/modules/terminal/lib/binding-aware-async-action";

// Remember the last terminal search query + options for this run so reopening
// the search bar (in any terminal) restores the previous lookup instead of an
// empty box. Module-level on purpose: transient, shared across terminals, and
// not worth persisting to disk.
let lastTerminalSearch = { query: "", useRegex: false, caseSensitive: false };
type TerminalSearch = typeof lastTerminalSearch;

// Resolve decorations lazily so searches follow the current terminal theme.
function getSearchOptions({ useRegex, caseSensitive }: TerminalSearch) {
  const { theme } = useUIStore.getState();
  return {
    regex: useRegex,
    caseSensitive,
    wholeWord: false,
    decorations: getSearchDecorations(theme),
  };
}

export function useTerminalSearch(sessionId: string) {
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchOpenRef = useRef(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState(lastTerminalSearch);
  const [searchCount, setSearchCount] = useState<{ current: number; total: number } | null>(null);

  const runSearch = useCallback((next: TerminalSearch) => {
    if (next.query) {
      searchAddonRef.current?.findNext(next.query, getSearchOptions(next));
    } else {
      searchAddonRef.current?.clearDecorations();
      setSearchCount(null);
    }
  }, []);

  const registerSearchAddon = useCallback((searchAddon: SearchAddon) => {
    searchAddonRef.current = searchAddon;
    return searchAddon.onDidChangeResults((e) => {
      if (e.resultCount === 0) setSearchCount({ current: 0, total: 0 });
      else setSearchCount({ current: e.resultIndex + 1, total: e.resultCount });
    });
  }, []);

  const closeSearch = useCallback(() => {
    const token = issueFocusReturnToken(sessionId);
    searchOpenRef.current = false;
    setSearchOpen(false);
    setSearchCount(null);
    searchAddonRef.current?.clearDecorations();
    if (token) bindingAwareAsyncAction(token).focus();
  }, [sessionId]);

  const openSearch = useCallback(() => {
    const token = issueFocusReturnToken(sessionId);
    if (!token) return;
    const action = bindingAwareAsyncAction(token);
    if (!action.isCurrent()) return;
    searchOpenRef.current = true;
    setSearchOpen(true);
    const restored = lastTerminalSearch;
    setSearch(restored);
    runSearch(restored);
    requestAnimationFrame(() => {
      if (!action.isCurrent()) return;
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, [runSearch, sessionId]);

  const handleCustomKeyEvent = useCallback((e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLocaleLowerCase() === "f" && e.type === "keydown") {
      openSearch();
      return false;
    }
    if (e.key === "Escape" && e.type === "keydown" && searchOpenRef.current) {
      closeSearch();
      return false;
    }
    return true;
  }, [closeSearch, openSearch]);

  const updateSearch = useCallback((next: TerminalSearch) => {
    lastTerminalSearch = next;
    setSearch(next);
    runSearch(next);
  }, [runSearch]);

  const handleSearchChange = useCallback((value: string) => {
    updateSearch({ ...search, query: value });
  }, [search, updateSearch]);

  const handleSearchNext = useCallback(() => {
    searchAddonRef.current?.findNext(search.query, getSearchOptions(search));
  }, [search]);

  const handleSearchPrev = useCallback(() => {
    searchAddonRef.current?.findPrevious(search.query, getSearchOptions(search));
  }, [search]);

  const toggleRegex = useCallback(() => {
    updateSearch({ ...search, useRegex: !search.useRegex });
  }, [search, updateSearch]);

  const toggleCaseSensitive = useCallback(() => {
    updateSearch({ ...search, caseSensitive: !search.caseSensitive });
  }, [search, updateSearch]);

  return {
    searchInputRef,
    searchOpen,
    searchQuery: search.query,
    searchCount,
    useRegex: search.useRegex,
    caseSensitive: search.caseSensitive,
    registerSearchAddon,
    handleCustomKeyEvent,
    handleSearchChange,
    handleSearchNext,
    handleSearchPrev,
    toggleRegex,
    toggleCaseSensitive,
    openSearch,
    closeSearch,
  };
}
