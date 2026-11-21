import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { FileExplorer } from "@/ui/FileExplorer";

test.each([true, false])("reports incomplete filename results (partial=%s)", async (partial) => {
  mockIPC((command) => {
    if (command === "fs_search") return {
      hits: partial ? [{ path: "/repo/match.txt", rel: "match.txt", name: "match.txt", isDir: false }] : [],
      unreadable: 1,
    };
    if (command === "fs_resolve_dir") return "/repo";
    return [];
  });
  render(<FileExplorer sessionId="unreadable" rootDir="/repo" />);
  fireEvent.change(screen.getByPlaceholderText("Search this folder"), { target: { value: "match" } });
  expect(await screen.findByText("Skipped 1 unreadable folder — results may be incomplete")).toBeTruthy();
  if (partial) expect(screen.getByRole("button", { name: /^match.txt/ })).toBeTruthy();
  else expect(screen.getByText("No matching files")).toBeTruthy();
});

test.each([true, false])("reports incomplete content results (partial=%s)", async (partial) => {
  mockIPC((command) => {
    if (command === "fs_grep") return {
      hits: partial ? [{ path: "/repo/match.txt", rel: "match.txt", line: 1, text: "match" }] : [],
      unreadable: 1, truncated: false, filesScanned: 1,
    };
    if (command === "fs_resolve_dir") return "/repo";
    return [];
  });
  render(<FileExplorer sessionId="unreadable-content" rootDir="/repo" />);
  const toggle = screen.queryByRole("button", { name: "Switch to content search" });
  if (toggle) fireEvent.click(toggle);
  fireEvent.change(screen.getByPlaceholderText("Search in file contents"), { target: { value: "match" } });
  expect(await screen.findByText("Skipped 1 unreadable folder — results may be incomplete")).toBeTruthy();
  if (partial) expect(screen.getByText("match.txt")).toBeTruthy();
  else expect(screen.getByText("No matching content")).toBeTruthy();
});
