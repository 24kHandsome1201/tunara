import { useEffect, useRef } from "react";
import { info, error as logError } from "@tauri-apps/plugin-log";
import { useSessionsStore } from "@/state/sessions";
import {
  probeTerminalCommandMarker,
  TERMINAL_BENCHMARK_VARIANT,
  waitForTerminalBenchmarkWriters,
} from "@/modules/terminal/lib/terminal-benchmark";

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
  throw new Error(`M2 local benchmark timed out waiting for ${label}: ${document.body.innerText.replace(/\s+/g, " ").slice(0, 500)}`);
}

function shellQuote(value: string): string {
  return `'${value.split("'").join(`'"'"'`)}'`;
}

function fileButton(path: string): HTMLButtonElement | null {
  return [...document.querySelectorAll<HTMLButtonElement>("button[data-file-path]")]
    .find((button) => button.dataset.filePath === path) ?? null;
}

function sessionTab(label: string): HTMLButtonElement | null {
  return [...document.querySelectorAll<HTMLButtonElement>('button[role="tab"]')]
    .find((button) => button.textContent?.trim() === label) ?? null;
}

function editorStatus(state: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.file-editor-status[data-state="${state}"]`);
}

function editorAction(action: string): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(`button[data-editor-action="${action}"]`);
}

async function openFile(path: string): Promise<HTMLTextAreaElement> {
  (await waitFor(`file button ${path}`, () => fileButton(path))).click();
  return waitFor("editor textarea", () => document.querySelector<HTMLTextAreaElement>(".file-editor-surface textarea"));
}

async function closeCleanEditor(): Promise<void> {
  const close = await waitFor("clean editor close", () => document.querySelector<HTMLButtonElement>(".file-editor-header .file-editor-icon-button"));
  close.click();
  await waitFor("editor closed", () => document.querySelector(".file-editor-surface") ? null : true);
}

function replaceTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (!setter) throw new Error("textarea value setter unavailable");
  setter.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

async function mutateThroughPty(sessionId: string, command: string, reference: string): Promise<number> {
  return probeTerminalCommandMarker(sessionId, `${command}\n`, reference);
}

export function useM2LocalSafeWriteBenchmark(ready: boolean): void {
  const startedRef = useRef(false);

  useEffect(() => {
    if (TERMINAL_BENCHMARK_VARIANT !== "m2-local-safe-write" || !ready || startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;

    void (async () => {
      const sessions = useSessionsStore.getState().sessions.filter((session) => !session.remote);
      if (sessions.length !== 2) throw new Error(`M2 local benchmark requires exactly two local sessions, got ${sessions.length}`);
      const [first, second] = sessions;
      const firstPath = `${first.dir}/first.md`;
      const secondPath = `${first.dir}/second.md`;
      const otherSessionPath = `${second.dir}/other.md`;
      useSessionsStore.setState({
        launchedSessionIds: { [first.id]: true, [second.id]: true },
        activeSessionId: first.id,
      });
      await waitForTerminalBenchmarkWriters([first.id, second.id]);
      if (cancelled) return;

      const firstOpenStartedAt = performance.now();
      let textarea = await openFile(firstPath);
      const firstOpenMs = Math.round((performance.now() - firstOpenStartedAt) * 100) / 100;
      replaceTextareaValue(textarea, "saved\n");
      const save = await waitFor("enabled Save", () => {
        const button = editorAction("save");
        return button && !button.disabled ? button : null;
      });
      save.click();
      await waitFor("saved state", () => editorStatus("saved"));
      const savedFingerprint = (await waitFor("clean Save", () => editorAction("save")?.disabled ? editorAction("save") : null))?.disabled === true;
      await closeCleanEditor();

      textarea = await openFile(secondPath);
      const crossFileContentCorrect = textarea.value === "second\n";
      await closeCleanEditor();

      (await waitFor("second session tab", () => sessionTab(second.title))).click();
      await waitFor("second session active", () => useSessionsStore.getState().activeSessionId === second.id ? true : null);
      textarea = await openFile(otherSessionPath);
      const crossSessionContentCorrect = textarea.value === "other-session\n";
      await closeCleanEditor();

      (await waitFor("first session tab", () => sessionTab(first.title))).click();
      await waitFor("first session active", () => useSessionsStore.getState().activeSessionId === first.id ? true : null);
      textarea = await openFile(firstPath);
      const reopenedSavedContent = textarea.value === "saved\n";
      const reopenedClean = Boolean(editorAction("save")?.disabled);

      replaceTextareaValue(textarea, "mine!\n");
      const externalMarker = `__TUNARA_M2_LOCAL_EXTERNAL_${Date.now().toString(36)}__`;
      const externalReference = `${externalMarker}:other`;
      const externalMutationMs = await mutateThroughPty(
        first.id,
        `printf 'other\\n' > ${shellQuote(firstPath)}; printf '%s:%s\\n' ${shellQuote(externalMarker)} other`,
        externalReference,
      );
      (await waitFor("conflict Save", () => {
        const button = editorAction("save");
        return button && !button.disabled ? button : null;
      })).click();
      await waitFor("conflict state", () => editorStatus("conflict"));
      const conflictDraftPreserved = textarea.value === "mine!\n";

      (await waitFor("second tab while dirty", () => sessionTab(second.title))).click();
      await waitFor("dirty switch warning", () => document.querySelector<HTMLElement>(".file-editor-close-confirm"));
      const switchBlockedWithDirtyDraft = useSessionsStore.getState().activeSessionId === first.id;
      const cancel = await waitFor("cancel dirty switch", () => {
        const box = document.querySelector(".file-editor-close-confirm");
        return box?.querySelector<HTMLButtonElement>('button:not([data-danger="true"])') ?? null;
      });
      cancel.click();
      await waitFor("dirty warning closed", () => document.querySelector(".file-editor-close-confirm") ? null : true);
      const draftStillPresentAfterCancel = textarea.value === "mine!\n";

      (await waitFor("reload conflict", () => editorAction("reload"))).click();
      await waitFor("external content reloaded", () => textarea.value === "other\n" ? textarea : null);
      await waitFor("clean after conflict reload", () => editorStatus("idle"));
      await closeCleanEditor();

      const postCleanMarker = `__TUNARA_M2_LOCAL_CLEAN_${Date.now().toString(36)}__`;
      await mutateThroughPty(
        first.id,
        `printf 'third\\n' > ${shellQuote(firstPath)}; printf '%s:%s\\n' ${shellQuote(postCleanMarker)} third`,
        `${postCleanMarker}:third`,
      );
      textarea = await openFile(firstPath);
      const cleanRegistryReleased = textarea.value === "third\n";

      replaceTextareaValue(textarea, "draft\n");
      const failureMarker = `__TUNARA_M2_LOCAL_FAIL_${Date.now().toString(36)}__`;
      await mutateThroughPty(
        first.id,
        `chmod 500 ${shellQuote(first.dir)}; printf '%s:%s\\n' ${shellQuote(failureMarker)} armed`,
        `${failureMarker}:armed`,
      );
      (await waitFor("failure Save", () => {
        const button = editorAction("save");
        return button && !button.disabled ? button : null;
      })).click();
      await waitFor("save error state", () => editorStatus("error"));
      const failureDraftPreserved = textarea.value === "draft\n";
      const restoreMarker = `__TUNARA_M2_LOCAL_RESTORE_${Date.now().toString(36)}__`;
      await mutateThroughPty(
        first.id,
        `chmod 700 ${shellQuote(first.dir)}; content=$(tr -d '\\n' < ${shellQuote(firstPath)}); printf '%s:%s\\n' ${shellQuote(restoreMarker)} "$content"`,
        `${restoreMarker}:third`,
      );

      const report = {
        benchmark: "m2-local-safe-write-gui",
        transport: "local",
        timestamp: new Date().toISOString(),
        fixtures: { firstPath, secondPath, otherSessionPath },
        saveReopen: { savedFingerprint, crossFileContentCorrect, crossSessionContentCorrect, reopenedSavedContent, reopenedClean },
        conflict: { conflictSeen: true, conflictDraftPreserved, externalMutationMs: Math.round(externalMutationMs * 100) / 100 },
        draftLifecycle: { switchBlockedWithDirtyDraft, draftStillPresentAfterCancel, cleanRegistryReleased },
        failure: { errorSeen: true, failureDraftPreserved, originalFilePreserved: true },
        timings: { firstOpenMs },
      };
      const booleans = [
        ...Object.values(report.saveReopen),
        report.conflict.conflictSeen,
        report.conflict.conflictDraftPreserved,
        ...Object.values(report.draftLifecycle),
        ...Object.values(report.failure),
      ];
      await info(`[benchmark:m2-local-safe-write] ${JSON.stringify({ ...report, passed: booleans.every(Boolean) })}`);
    })().catch(async (reason) => {
      await logError(`[benchmark:m2-local-safe-write] ${JSON.stringify({
        benchmark: "m2-local-safe-write-gui",
        timestamp: new Date().toISOString(),
        passed: false,
        error: String(reason),
      })}`);
    });

    return () => { cancelled = true; };
  }, [ready]);
}
