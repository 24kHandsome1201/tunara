import { mockIPC } from "@tauri-apps/api/mocks";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, test } from "vitest";
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
});
