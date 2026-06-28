import { useCallback, useRef, useState, type RefObject } from "react";
import type { Terminal } from "@xterm/xterm";
import { SearchAddon } from "@xterm/addon-search";

const SEARCH_DECORATIONS = {
  matchBackground: "#e8a96044",
  matchOverviewRuler: "#e8a960",
  activeMatchBackground: "#e8a960aa",
  activeMatchColorOverviewRuler: "#e8a960",
};

// Remember the last terminal search query + options for this run so reopening
// the search bar (in any terminal) restores the previous lookup instead of an
// empty box. Module-level on purpose: transient, shared across terminals, and
// not worth persisting to disk.
const lastTerminalSearch = { query: "", useRegex: false, caseSensitive: false };

export function useTerminalSearch(termRef: RefObject<Terminal | null>) {
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchOpenRef = useRef(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState(lastTerminalSearch.query);
  const [searchCount, setSearchCount] = useState<{ current: number; total: number } | null>(null);
  const [useRegex, setUseRegex] = useState(lastTerminalSearch.useRegex);
  const [caseSensitive, setCaseSensitive] = useState(lastTerminalSearch.caseSensitive);

  const optionsRef = useRef({ useRegex: lastTerminalSearch.useRegex, caseSensitive: lastTerminalSearch.caseSensitive });
  optionsRef.current = { useRegex, caseSensitive };

  const getSearchOptions = useCallback(() => ({
    regex: optionsRef.current.useRegex,
    caseSensitive: optionsRef.current.caseSensitive,
    wholeWord: false,
    decorations: SEARCH_DECORATIONS,
  }), []);

  const registerSearchAddon = useCallback((searchAddon: SearchAddon) => {
    searchAddonRef.current = searchAddon;
    return searchAddon.onDidChangeResults((e) => {
      if (e.resultCount === 0) setSearchCount(null);
      else setSearchCount({ current: e.resultIndex + 1, total: e.resultCount });
    });
  }, []);

  const closeSearch = useCallback(() => {
    searchOpenRef.current = false;
    setSearchOpen(false);
    setSearchCount(null);
    // Keep searchQuery in state and lastTerminalSearch so the next open restores
    // it; only drop the live highlights.
    searchAddonRef.current?.clearDecorations();
    termRef.current?.focus();
  }, [termRef]);

  const handleCustomKeyEvent = useCallback((e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "f" && e.type === "keydown") {
      searchOpenRef.current = true;
      setSearchOpen(true);
      // Re-run the remembered query so reopening lands on live matches, and
      // select the input text so typing replaces it.
      const restored = lastTerminalSearch.query;
      if (restored && searchAddonRef.current) {
        searchAddonRef.current.findNext(restored, getSearchOptions());
      }
      requestAnimationFrame(() => searchInputRef.current?.select());
      return false;
    }
    if (e.key === "Escape" && e.type === "keydown" && searchOpenRef.current) {
      closeSearch();
      return false;
    }
    return true;
  }, [closeSearch, getSearchOptions]);

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    lastTerminalSearch.query = value;
    if (!searchAddonRef.current) return;
    if (value) {
      searchAddonRef.current.findNext(value, getSearchOptions());
    } else {
      searchAddonRef.current.clearDecorations();
      setSearchCount(null);
    }
  }, [getSearchOptions]);

  const handleSearchNext = useCallback(() => {
    searchAddonRef.current?.findNext(searchQuery, getSearchOptions());
  }, [searchQuery, getSearchOptions]);

  const handleSearchPrev = useCallback(() => {
    searchAddonRef.current?.findPrevious(searchQuery, getSearchOptions());
  }, [searchQuery, getSearchOptions]);

  const toggleRegex = useCallback(() => {
    setUseRegex((prev) => {
      const next = !prev;
      optionsRef.current.useRegex = next;
      lastTerminalSearch.useRegex = next;
      if (searchQuery && searchAddonRef.current) {
        searchAddonRef.current.findNext(searchQuery, getSearchOptions());
      }
      return next;
    });
  }, [searchQuery, getSearchOptions]);

  const toggleCaseSensitive = useCallback(() => {
    setCaseSensitive((prev) => {
      const next = !prev;
      optionsRef.current.caseSensitive = next;
      lastTerminalSearch.caseSensitive = next;
      if (searchQuery && searchAddonRef.current) {
        searchAddonRef.current.findNext(searchQuery, getSearchOptions());
      }
      return next;
    });
  }, [searchQuery, getSearchOptions]);

  return {
    searchInputRef,
    searchOpen,
    searchQuery,
    searchCount,
    useRegex,
    caseSensitive,
    registerSearchAddon,
    handleCustomKeyEvent,
    handleSearchChange,
    handleSearchNext,
    handleSearchPrev,
    toggleRegex,
    toggleCaseSensitive,
    closeSearch,
  };
}
