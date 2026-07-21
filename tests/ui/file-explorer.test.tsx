import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { FileExplorer } from "@/ui/FileExplorer";

describe("FileExplorer preview navigation", () => {
  test("opens the first remote file when no preview is active", async () => {
    mockIPC((command) => {
      if (command === "ssh_fs_read_dir") {
        return [{ name: "fixture.md", kind: "file", size: 7, mtime: 0 }];
      }
      if (command === "ssh_fs_read_file") {
        return {
          kind: "text",
          content: "before\n",
          size: 7,
          fingerprint: "a".repeat(64),
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });

    render(<FileExplorer rootDir="/tmp/repo" remotePtyId={41} />);
    fireEvent.click(await screen.findByRole("button", { name: /^fixture\.md/ }));

    await screen.findByRole("textbox", { name: "Edit fixture.md" });
  });

  test("retries a failed search without changing the query", async () => {
    let searchAttempts = 0;
    mockIPC((command) => {
      if (command === "ssh_fs_read_dir") return [];
      if (command === "ssh_fs_search") {
        searchAttempts += 1;
        if (searchAttempts === 1) throw new Error("temporary search failure");
        return [{ path: "/tmp/repo/match.txt", rel: "match.txt", name: "match.txt", isDir: false }];
      }
      if (command === "fs_cancel_search") return true;
      throw new Error(`unexpected command: ${command}`);
    });

    render(<FileExplorer rootDir="/tmp/repo" remotePtyId={42} />);
    fireEvent.change(screen.getByPlaceholderText("Search current project"), { target: { value: "match" } });
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("button", { name: /^match\.txt/ })).toBeTruthy();
    expect(screen.getByPlaceholderText("Search current project")).toHaveProperty("value", "match");
    expect(searchAttempts).toBe(2);
  });
});
