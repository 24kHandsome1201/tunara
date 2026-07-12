import { useEffect, useRef } from "react";
import { info, error as logError } from "@tauri-apps/plugin-log";
import { useSessionsStore } from "@/state/sessions";
import { TERMINAL_BENCHMARK_VARIANT } from "@/modules/terminal/lib/terminal-benchmark";

const WAIT_TIMEOUT_MS = 30_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(label: string, read: () => T | null): Promise<T> {
  const deadline = performance.now() + WAIT_TIMEOUT_MS;
  while (performance.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await delay(25);
  }
  throw new Error(`M2 native-close benchmark timed out waiting for ${label}`);
}

function replaceTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (!setter) throw new Error("textarea value setter unavailable");
  setter.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function fileButton(path: string): HTMLButtonElement | null {
  return [...document.querySelectorAll<HTMLButtonElement>("button[data-file-path]")]
    .find((button) => button.dataset.filePath === path) ?? null;
}

function warning(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".file-editor-close-confirm");
}

async function marker(stage: string, details: Record<string, unknown> = {}): Promise<void> {
  await info(`[benchmark:m2-native-close:${stage}] ${JSON.stringify({ stage, timestamp: new Date().toISOString(), ...details })}`);
}

export function useM2NativeCloseBenchmark(ready: boolean): void {
  const startedRef = useRef(false);

  useEffect(() => {
    if (TERMINAL_BENCHMARK_VARIANT !== "m2-native-close" || !ready || startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;

    void (async () => {
      const sessions = useSessionsStore.getState().sessions.filter((session) => !session.remote);
      if (sessions.length !== 1) throw new Error(`M2 native-close benchmark requires exactly one local session, got ${sessions.length}`);
      const session = sessions[0];
      const filePath = `${session.dir}/draft.md`;
      const button = await waitFor("draft file", () => fileButton(filePath));
      button.click();
      const textarea = await waitFor("editor textarea", () => document.querySelector<HTMLTextAreaElement>(".file-editor-surface textarea"));
      replaceTextareaValue(textarea, "unsaved native close draft\n");
      await waitFor("enabled Save", () => {
        const save = document.querySelector<HTMLButtonElement>('button[data-editor-action="save"]');
        return save && !save.disabled ? save : null;
      });
      await marker("dirty-ready", { filePath, draft: textarea.value });

      const firstWarning = await waitFor("first native-close warning", warning);
      const firstWarningVisible = firstWarning.getClientRects().length > 0;
      const cancel = firstWarning.querySelector<HTMLButtonElement>('button:not([data-danger="true"])');
      if (!cancel) throw new Error("cancel button unavailable");
      cancel.click();
      await waitFor("warning dismissed after cancel", () => warning() ? null : true);
      await marker("cancel-complete", {
        firstWarningVisible,
        draftPreserved: textarea.value === "unsaved native close draft\n",
        editorPreserved: textarea.isConnected,
      });

      const secondWarning = await waitFor("second native-close warning", warning);
      const discard = secondWarning.querySelector<HTMLButtonElement>('button[data-danger="true"]');
      if (!discard) throw new Error("discard button unavailable");
      const secondWarningVisible = secondWarning.getClientRects().length > 0;
      discard.click();
      await waitFor("warning dismissed after discard", () => warning() ? null : true);
      await marker("discard-complete", { secondWarningVisible });

      await delay(500);
      if (cancelled) return;
      await marker("clean-ready", { warningVisible: Boolean(warning()) });
    })().catch(async (reason) => {
      await logError(`[benchmark:m2-native-close:error] ${JSON.stringify({
        stage: "error",
        timestamp: new Date().toISOString(),
        error: String(reason),
      })}`);
    });

    return () => { cancelled = true; };
  }, [ready]);
}
