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
      searchAddonRef.current.findNext(value, {
        regex: false,
        caseSensitive: false,
        wholeWord: false,
        decorations: SEARCH_DECORATIONS,
      });
    } else {
      searchAddonRef.current.clearDecorations();
      setSearchCount(null);
    }
  }, []);

  const handleSearchNext = useCallback(() => {
    searchAddonRef.current?.findNext(searchQuery, {
      regex: false,
      caseSensitive: false,
      wholeWord: false,
      decorations: SEARCH_DECORATIONS,
    });
  }, [searchQuery]);

  const handleSearchPrev = useCallback(() => {
    searchAddonRef.current?.findPrevious(searchQuery, {
      regex: false,
      caseSensitive: false,
      wholeWord: false,
      decorations: SEARCH_DECORATIONS,
    });
  }, [searchQuery]);

  return {
    searchInputRef,
    searchOpen,
    searchQuery,
    searchCount,
    registerSearchAddon,
    handleCustomKeyEvent,
    handleSearchChange,
    handleSearchNext,
    handleSearchPrev,
    closeSearch,
  };
}
