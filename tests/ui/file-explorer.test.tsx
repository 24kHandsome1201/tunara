import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { FileExplorer } from "@/ui/FileExplorer";

describe("FileExplorer directory navigation", () => {
  test.each([
    ["root", "/root", ["/root", "/"]],
    ["ordinary user", "/home/alice", ["/home/alice", "/home", "/"]],
  ])("lets an SSH %s session browse from its cwd to the filesystem root", async (_user, rootDir, expectedPaths) => {
    const readPaths: string[] = [];
    mockIPC((command, payload) => {
      if (command === "ssh_fs_read_dir") {
        readPaths.push((payload as { path: string }).path);
        return [];
      }
      throw new Error(`unexpected command: ${command}`);
    });

    render(<FileExplorer rootDir={rootDir} remotePtyId={40} />);
    await waitFor(() => expect(readPaths[readPaths.length - 1]).toBe(expectedPaths[0]));

    for (const parent of expectedPaths.slice(1)) {
      const goUp = screen.getByRole("button", { name: "Go to parent" }) as HTMLButtonElement;
      expect(goUp.disabled).toBe(false);
      fireEvent.click(goUp);
      await waitFor(() => expect(readPaths[readPaths.length - 1]).toBe(parent));
    }

    expect((screen.getByRole("button", { name: "Go to parent" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("button", { name: "/" }).getAttribute("aria-current")).toBe("page");
  });

  test("keeps a local explorer scoped to its starting directory", async () => {
    mockIPC((command) => {
      if (command === "fs_read_dir") return [];
      throw new Error(`unexpected command: ${command}`);
    });

    render(<FileExplorer rootDir="/tmp/repo" />);
    await screen.findByText("Directory is empty");

    expect((screen.getByRole("button", { name: "Go to parent" }) as HTMLButtonElement).disabled).toBe(true);
  });
});

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
