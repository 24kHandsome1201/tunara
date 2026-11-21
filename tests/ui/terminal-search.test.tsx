import { act, renderHook } from "@testing-library/react";
import type { SearchAddon } from "@xterm/addon-search";
import { expect, test, vi } from "vitest";
import {
  registerTerminalBinding,
  setLogicalActiveTerminalPane,
} from "@/modules/terminal/lib/binding-aware-async-action";
import { useTerminalSearch } from "@/ui/useTerminalSearch";

function mountSearch(id: string, ptyId: number) {
  registerTerminalBinding({
    logicalSessionId: id,
    paneId: id,
    physicalPtyId: ptyId,
    transportGeneration: id,
    terminalInstanceEpoch: ptyId,
  }, vi.fn());
  const { result } = renderHook(() => useTerminalSearch(id));
  const addon = {
    findNext: vi.fn(),
    findPrevious: vi.fn(),
    clearDecorations: vi.fn(),
    onDidChangeResults: () => ({ dispose() {} }),
  };
  act(() => { result.current.registerSearchAddon(addon as unknown as SearchAddon); });
  return { search: result, addon };
}

test("reopening Find uses the last query and options for both the bar and the search", () => {
  const a = mountSearch("a", 1);
  const b = mountSearch("b", 2);

  setLogicalActiveTerminalPane("a");
  act(() => a.search.current.openSearch());
  act(() => a.search.current.handleSearchChange("alpha"));
  act(() => a.search.current.closeSearch());

  setLogicalActiveTerminalPane("b");
  act(() => b.search.current.openSearch());
  act(() => b.search.current.handleSearchChange("beta"));
  act(() => b.search.current.toggleRegex());
  act(() => b.search.current.toggleCaseSensitive());
  act(() => b.search.current.closeSearch());

  setLogicalActiveTerminalPane("a");
  a.addon.findNext.mockClear();
  act(() => a.search.current.openSearch());

  const options = expect.objectContaining({ regex: true, caseSensitive: true });
  expect(a.addon.findNext.mock.lastCall?.[0]).toBe("beta");
  expect(a.search.current).toMatchObject({
    searchQuery: "beta", useRegex: true, caseSensitive: true,
  });
  expect(a.addon.findNext).toHaveBeenCalledExactlyOnceWith("beta", options);

  act(() => a.search.current.handleSearchNext());
  act(() => a.search.current.handleSearchPrev());
  expect(a.addon.findNext).toHaveBeenLastCalledWith("beta", options);
  expect(a.addon.findPrevious).toHaveBeenCalledExactlyOnceWith("beta", options);

  act(() => a.search.current.closeSearch());
  setLogicalActiveTerminalPane("b");
  act(() => b.search.current.openSearch());
  act(() => b.search.current.handleSearchChange(""));
  act(() => b.search.current.closeSearch());

  setLogicalActiveTerminalPane("a");
  a.addon.findNext.mockClear();
  a.addon.clearDecorations.mockClear();
  act(() => a.search.current.openSearch());
  expect(a.search.current.searchQuery).toBe("");
  expect(a.search.current.searchCount).toBeNull();
  expect(a.addon.findNext).not.toHaveBeenCalled();
  expect(a.addon.clearDecorations).toHaveBeenCalledOnce();
});
