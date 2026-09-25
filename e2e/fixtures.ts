import { expect, test as base, type Page } from "@playwright/test";
import "./mock-backend";

type BackendProbe = {
  ptyWrites: (ptyId?: number) => Promise<string>;
  openPtyIds: () => Promise<number[]>;
  callCount: (cmd: string) => Promise<number>;
  emitPtyOutput: (ptyId: number, text: string) => Promise<void>;
};

/** Reads the in-page mock backend installed by `e2e/boot.ts`. */
function probe(page: Page): BackendProbe {
  return {
    ptyWrites: (ptyId) => page.evaluate((id) => window.__TUNARA_E2E__!.ptyWrites(id ?? undefined), ptyId ?? null),
    openPtyIds: () => page.evaluate(() => window.__TUNARA_E2E__!.openPtyIds()),
    callCount: (cmd) => page.evaluate((name) => window.__TUNARA_E2E__!.callCount(name), cmd),
    emitPtyOutput: (ptyId, text) =>
      page.evaluate(([id, value]) => window.__TUNARA_E2E__!.emitPtyOutput(id, value), [ptyId, text] as const),
  };
}

export const test = base.extend<{ backend: BackendProbe; failOnPageErrors: void }>({
  failOnPageErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await use();
      expect(errors, "uncaught page errors").toEqual([]);
    },
    { auto: true },
  ],
  backend: async ({ page }, use) => {
    await use(probe(page));
  },
});

export { expect };

/** Session id of the terminal pane that currently owns keyboard focus. */
export function focusedTerminalSessionId(page: Page): Promise<string | null> {
  return page.evaluate(
    () => document.activeElement?.closest("[data-terminal-session-id]")?.getAttribute("data-terminal-session-id") ?? null,
  );
}

export function terminalSessionIds(page: Page): Promise<string[]> {
  return page.locator("[data-terminal-session-id]").evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-terminal-session-id") ?? ""),
  );
}

/** Boots the app on an empty workspace and opens one local terminal. */
export async function openLocalTerminal(page: Page, backend: BackendProbe): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Local terminal" }).click();
  await expect(page.locator(".xterm")).toHaveCount(1);
  await expect.poll(() => backend.openPtyIds()).toEqual([1]);
  await expect(page.locator(".xterm-rows").first()).toContainText("e2e$");
}
