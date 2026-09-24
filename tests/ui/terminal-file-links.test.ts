import { waitFor } from "@testing-library/react";
import type { ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { expect, test, vi } from "vitest";
import { registerTerminalFileLinkProvider } from "@/modules/terminal/lib/terminal-file-links";
import { useUIStore } from "@/state/ui";

function fakeTerminal(text: string): { term: Terminal; provider: () => ILinkProvider } {
  let registered: ILinkProvider | null = null;
  const cells = [...text].map((char) => ({ getChars: () => char, getWidth: () => 1 }));
  const line = { length: cells.length, translateToString: () => text, getCell: (x: number) => cells[x] };
  const term = {
    buffer: { active: { getLine: () => line } },
    registerLinkProvider: (provider: ILinkProvider) => {
      registered = provider;
      return { dispose() {} };
    },
  } as unknown as Terminal;
  return { term, provider: () => registered! };
}

test("a terminal file link that fails to open is logged and surfaced as an error toast", async () => {
  useUIStore.setState({ toasts: [] });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const { term, provider } = fakeTerminal("error at src/app.ts:12");
  registerTerminalFileLinkProvider(term, {
    getCwd: () => "/work",
    // The owning session no longer exists, so openResource rejects.
    createResource: (path, line, column) => ({ transport: "local", logicalSessionId: "gone", path, line, column }),
  });

  let links: ILink[] | undefined;
  provider().provideLinks(1, (value) => { links = value; });
  expect(links).toHaveLength(1);
  const event = new MouseEvent("click");
  links![0].activate(event, links![0].text);

  await waitFor(() => expect(useUIStore.getState().toasts).toHaveLength(1));
  expect(useUIStore.getState().toasts[0].sessionId).toBeUndefined();
  expect(useUIStore.getState().toasts[0]).toMatchObject({
    title: "Couldn't open this file",
    subtitle: "/work/src/app.ts",
    variant: "error",
  });
  expect(warn).toHaveBeenCalledWith("[terminal-file-links] open failed", "/work/src/app.ts", expect.any(Error));
  warn.mockRestore();
});
