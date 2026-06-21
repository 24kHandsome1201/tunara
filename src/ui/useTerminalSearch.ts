import { useCallback, useRef, useState, type RefObject } from "react";
import { type Terminal } from "@xterm/xterm";
import { SearchAddon } from "@xterm/addon-search";

const SEARCH_DECORATIONS = {
  matchBackground: "#e8a96044",
  matchOverviewRuler: "#e8a960",
  activeMatchBackground: "#e8a960aa",
  activeMatchColorOverviewRuler: "#e8a960",
};

export function useTerminalSearch(termRef: RefObject<Terminal | null>) {
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchOpenRef = useRef(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchCount, setSearchCount] = useState<{ current: number; total: number } | null>(null);
  const [useRegex, setUseRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);

  const optionsRef = useRef({ useRegex: false, caseSensitive: false });
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
    setSearchQuery("");
    setSearchCount(null);
    searchAddonRef.current?.clearDecorations();
    termRef.current?.focus();
  }, [termRef]);

  const handleCustomKeyEvent = useCallback((e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "f" && e.type === "keydown") {
      searchOpenRef.current = true;
      setSearchOpen(true);
      return false;
    }
    if (e.key === "Escape" && e.type === "keydown" && searchOpenRef.current) {
      closeSearch();
      return false;
    }
    return true;
  }, [closeSearch]);

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
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
