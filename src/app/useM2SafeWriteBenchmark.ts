import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { info, error as logError } from "@tauri-apps/plugin-log";
import { useSessionsStore } from "@/state/sessions";
import {
  probeTerminalCommandMarker,
  TERMINAL_BENCHMARK_VARIANT,
  waitForTerminalBenchmarkWriters,
} from "@/modules/terminal/lib/terminal-benchmark";
import { disconnectAndReconnectSshBenchmarkSession } from "./useTerminalBenchmark";

const WAIT_TIMEOUT_MS = 30_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeUiState(): string {
  const text = document.body.innerText.replace(/\s+/g, " ").trim().slice(0, 600);
  return JSON.stringify({
    fileButtons: document.querySelectorAll("button[data-file-path]").length,
    editorSurface: Boolean(document.querySelector(".file-editor-surface")),
    textarea: Boolean(document.querySelector(".file-editor-surface textarea")),
    text,
  });
}

function shellQuote(value: string): string {
  return `'${value.split("'").join(`'"'"'`)}'`;
}

async function waitFor<T>(label: string, read: () => T | null, timeoutMs = WAIT_TIMEOUT_MS): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await delay(25);
  }
  throw new Error(`M2 benchmark timed out waiting for ${label}; ui=${describeUiState()}`);
}

function fileButton(path: string): HTMLButtonElement | null {
  return [...document.querySelectorAll<HTMLButtonElement>("button[data-file-path]")]
    .find((button) => button.dataset.filePath === path) ?? null;
}

function editorStatus(state: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.file-editor-status[data-state="${state}"]`);
}

async function openFixture(path: string): Promise<HTMLTextAreaElement> {
  (await waitFor("fixture file button", () => fileButton(path))).click();
  return waitFor("editor textarea", () => document.querySelector<HTMLTextAreaElement>(".file-editor-surface textarea"));
}

function replaceTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  if (!setter) throw new Error("textarea value setter unavailable");
  setter.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

export function useM2SafeWriteBenchmark(ready: boolean): void {
  const startedRef = useRef(false);

  useEffect(() => {
    if (TERMINAL_BENCHMARK_VARIANT !== "m2-safe-write" || !ready || startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;

    void (async () => {
      const expectedFingerprint = import.meta.env.VITE_TUNARA_M2_EXPECTED_SHA256 as string | undefined;
      if (!expectedFingerprint) {
        throw new Error("M2 benchmark build is missing the expected fingerprint");
      }
      const initial = useSessionsStore.getState();
      const session = initial.sessions.find((candidate) => candidate.remote);
      if (!session) throw new Error("M2 benchmark requires one restored SSH session");
      const fixturePath = `${session.dir.replace(/\/$/, "")}/fixture.md`;
      useSessionsStore.setState({
        launchedSessionIds: { [session.id]: true },
        activeSessionId: session.id,
      });
      const [readySessionId] = await waitForTerminalBenchmarkWriters([session.id]);
      if (!readySessionId || cancelled) return;
      const connected = await waitFor("SSH ready phase", () => {
        const current = useSessionsStore.getState().sessions.find((item) => item.id === session.id);
        return current?.ptyId !== undefined && current.connection?.phase === "ready" ? current : null;
      });

      const editorOpenStartedAt = performance.now();
      let textarea = await openFixture(fixturePath);
      const editorOpenMs = Math.round((performance.now() - editorOpenStartedAt) * 100) / 100;
      await invoke("plugin:m2-safe-write-benchmark|arm_release_failure", {
        id: connected.ptyId,
        path: fixturePath,
      });
      replaceTextareaValue(textarea, "after\n");
      await waitFor("React textarea value", () => textarea.value === "after\n" ? textarea : null);
      const save = await waitFor("Save button", () => document.querySelector<HTMLButtonElement>('button[data-editor-action="save"]'));
      const dirtyBeforeSave = !save.disabled;
      const unknownStartedAt = performance.now();
      save.click();
      await waitFor("outcomeUnknown editor state", () => editorStatus("unknown"));
      const unknownMs = Math.round((performance.now() - unknownStartedAt) * 100) / 100;
      const saveWhileUnknown = document.querySelector<HTMLButtonElement>('button[data-editor-action="save"]');
      const alert = document.querySelector<HTMLElement>(".file-editor-alert");
      const editorBeforeDisconnect = {
        opened: true,
        dirtyBeforeSave,
        saveClicked: true,
        unknownSeen: true,
        cleanupPendingCopySeen: Boolean(alert?.textContent?.includes("temporary file") || alert?.textContent?.includes("临时文件")),
        saveDisabledWhileUnknown: Boolean(saveWhileUnknown?.disabled),
        draftPreservedBeforeDisconnect: textarea.value === "after\n",
      };

      const recovery = await disconnectAndReconnectSshBenchmarkSession(session.id);
      if (cancelled) return;
      textarea = await openFixture(fixturePath);
      await waitFor("restored outcomeUnknown editor state", () => editorStatus("unknown"));
      const draftRestoredAfterReconnect = textarea.value === "after\n";
      const reconcile = await waitFor("reconcile button", () => document.querySelector<HTMLButtonElement>('button[data-editor-action="reconcile"]'));
      const reconcileStartedAt = performance.now();
      reconcile.click();
      await waitFor("saved editor state", () => editorStatus("saved"));
      const reconcileMs = Math.round((performance.now() - reconcileStartedAt) * 100) / 100;
      const finalSave = document.querySelector<HTMLButtonElement>('button[data-editor-action="save"]');

      const marker = `__TUNARA_M2_SAFE_WRITE_${Date.now().toString(36)}__`;
      const directory = fixturePath.slice(0, fixturePath.lastIndexOf("/"));
      const expectedReference = `${marker}:${expectedFingerprint}:640:0`;
      const verifyCommand = [
        `fingerprint=$(sha256sum ${shellQuote(fixturePath)} | awk '{print $1}')`,
        `mode=$(stat -c %a ${shellQuote(fixturePath)})`,
        `residue=$(find ${shellQuote(directory)} -maxdepth 1 \\( -name '*.tunara-*.tmp' -o -name '.tunara-write-*.lock' \\) -print | wc -l | tr -d ' ')`,
        `printf '%s:%s:%s:%s\\n' ${shellQuote(marker)} "$fingerprint" "$mode" "$residue"`,
      ].join("; ") + "\n";
      const markerEchoMs = await probeTerminalCommandMarker(
        session.id,
        verifyCommand,
        expectedReference,
      );
      const editor = {
        ...editorBeforeDisconnect,
        draftRestoredAfterReconnect,
        reconcileClicked: true,
        finalState: "saved",
        finalClean: Boolean(finalSave?.disabled),
      };
      const remote = {
        markerVisible: true,
        fingerprintMatch: true,
        mode: 0o640,
        modeOctal: "640",
        residueCount: 0,
        markerEchoMs: Math.round(markerEchoMs * 100) / 100,
      };
      const report = {
        benchmark: "m2-ssh-safe-write-gui",
        transport: "ssh",
        timestamp: new Date().toISOString(),
        sessionId: session.id,
        fixture: { path: fixturePath, expectedFingerprint, expectedMode: 0o640, modeOctal: "640" },
        editor,
        recovery,
        remote,
        timings: { editorOpenMs, unknownMs, reconcileMs },
        passed: Object.values(editor).every((value) => value === true || value === "saved")
          && recovery.passed
          && remote.fingerprintMatch
          && remote.mode === 0o640
          && remote.residueCount === 0,
      };
      await info(`[benchmark:m2-safe-write] ${JSON.stringify(report)}`);
    })().catch(async (reason) => {
      await logError(`[benchmark:m2-safe-write] ${JSON.stringify({
        benchmark: "m2-ssh-safe-write-gui",
        timestamp: new Date().toISOString(),
        passed: false,
        error: String(reason),
      })}`);
    });

    return () => { cancelled = true; };
  }, [ready]);
}
