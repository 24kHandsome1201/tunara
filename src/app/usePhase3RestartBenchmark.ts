import { useEffect, useRef } from "react";
import { error as logError, info } from "@tauri-apps/plugin-log";
import { createSession, useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import {
  previewClose,
  previewOpen,
  previewRefresh,
  previewRestartPrepare,
  previewStatus,
  type PreviewRuntimeState,
} from "@/modules/preview/preview-window";
import type { PreviewSource } from "@/modules/preview/preview-source";
import {
  probeTerminalCommandMarker,
  readTerminalBenchmarkSnapshot,
  TERMINAL_BENCHMARK_VARIANT,
  waitForTerminalBenchmarkWriters,
  writeTerminalBenchmark,
} from "@/modules/terminal/lib/terminal-benchmark";

const WAIT_MS = 30_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(label: string, read: () => T | null | undefined | Promise<T | null | undefined>): Promise<T> {
  const deadline = performance.now() + WAIT_MS;
  while (performance.now() < deadline) {
    const value = await read();
    if (value !== null && value !== undefined && value !== false) return value as T;
    await delay(50);
  }
  throw new Error(`Phase 3 restart benchmark timed out waiting for ${label}`);
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

async function rejected(action: () => Promise<unknown>): Promise<boolean> {
  try {
    await action();
    return false;
  } catch {
    return true;
  }
}

async function sourceFor(sessionId: string, url: string, generationAfter?: string): Promise<PreviewSource> {
  return waitFor(`source ${url}`, () => {
    const session = useSessionsStore.getState().sessions.find((candidate) => candidate.id === sessionId);
    const source = session?.previewSources?.find((candidate) => candidate.sourceUrl === url
      && candidate.state === "active"
      && candidate.workspaceResolution === "resolved"
      && candidate.physicalPtyId !== undefined
      && candidate.restartProvenance);
    return source && source.restartProvenance?.generation !== generationAfter ? source : null;
  });
}

async function runtimeFor(source: PreviewSource, predicate: (status: PreviewRuntimeState) => boolean): Promise<PreviewRuntimeState> {
  return waitFor(`Preview runtime ${source.sourceUrl}`, async () => {
    const status = await previewStatus(source);
    return status && predicate(status) ? status : null;
  });
}

async function waitForSettled(sessionId: string): Promise<void> {
  await waitFor(`settled terminal ${sessionId}`, () => {
    const session = useSessionsStore.getState().sessions.find((candidate) => candidate.id === sessionId);
    return session && session.runState !== "running" ? true : null;
  });
}

async function waitForCommandSettled(sessionId: string, command: string): Promise<void> {
  await waitFor(`submitted command ${sessionId}`, () => {
    const session = useSessionsStore.getState().sessions.find((candidate) => candidate.id === sessionId);
    return session?.previewCommandProvenance?.command === command ? true : null;
  });
  await waitForSettled(sessionId);
}

export function usePhase3RestartBenchmark(ready: boolean): void {
  const started = useRef(false);
  useEffect(() => {
    if (TERMINAL_BENCHMARK_VARIANT !== "phase3-restart" || !ready || started.current) return;
    started.current = true;
    let cancelled = false;
    void (async () => {
      const rootA = import.meta.env.VITE_TUNARA_PHASE3_ROOT_A as string | undefined;
      const rootB = import.meta.env.VITE_TUNARA_PHASE3_ROOT_B as string | undefined;
      const portA = Number(import.meta.env.VITE_TUNARA_PHASE3_PORT_A);
      const portB = Number(import.meta.env.VITE_TUNARA_PHASE3_PORT_B);
      if (!rootA || !rootB || !Number.isInteger(portA) || !Number.isInteger(portB)) {
        throw new Error("Phase 3 restart benchmark build is missing roots or ports");
      }
      const urlA = `http://127.0.0.1:${portA}/`;
      const urlB = `http://127.0.0.1:${portB}/`;
      const commandA = `python3 -m http.server ${portA} --bind 127.0.0.1`;
      const commandB = `python3 -m http.server ${portB} --bind 127.0.0.1`;
      const sessionA = createSession(rootA, { title: "Phase 3 restart A" });
      const sessionB = createSession(rootB, { title: "Phase 3 restart B" });
      useSessionsStore.setState({ sessions: [], activeSessionId: null, launchedSessionIds: {} });
      useUIStore.setState({ panelVisible: true, inspectorTab: "preview", overlay: null, split: { mode: "single", paneA: null, paneB: null, ratio: 0.5 } });
      await delay(0);
      useSessionsStore.getState().addSession(sessionA);
      useSessionsStore.getState().addSession(sessionB);
      useSessionsStore.getState().setActive(sessionA.id);
      const writers = await waitForTerminalBenchmarkWriters([sessionA.id, sessionB.id]);
      if (writers.length !== 2) throw new Error(`Phase 3 restart benchmark mounted ${writers.length}/2 PTYs`);
      await waitFor("resolved workspaces and physical PTYs", () => {
        const sessions = useSessionsStore.getState().sessions.filter((session) => session.id === sessionA.id || session.id === sessionB.id);
        return sessions.length === 2 && sessions.every((session) => session.workspace && session.ptyId !== undefined) ? true : null;
      });
      await Promise.all([
        probeTerminalCommandMarker(sessionA.id, "printf '%s\\n' PHASE3_SHELL_READY_A\n", "PHASE3_SHELL_READY_A"),
        probeTerminalCommandMarker(sessionB.id, "printf '%s\\n' PHASE3_SHELL_READY_B\n", "PHASE3_SHELL_READY_B"),
      ]);
      await Promise.all([
        waitForCommandSettled(sessionA.id, "printf '%s\\n' PHASE3_SHELL_READY_A"),
        waitForCommandSettled(sessionB.id, "printf '%s\\n' PHASE3_SHELL_READY_B"),
      ]);
      await Promise.all([
        writeTerminalBenchmark(sessionA.id, `${commandA}\n`),
        writeTerminalBenchmark(sessionB.id, `${commandB}\n`),
      ]);
      const [sourceA, sourceB] = await Promise.all([sourceFor(sessionA.id, urlA), sourceFor(sessionB.id, urlB)]);
      await Promise.all([previewOpen(sourceA), previewOpen(sourceB)]);
      await Promise.all([
        runtimeFor(sourceA, (status) => status.status === "ready"),
        runtimeFor(sourceB, (status) => status.status === "ready"),
      ]);
      const [aclA, aclB] = await Promise.all([
        waitFor("source A ACL completion", async () => (await readTerminalBenchmarkSnapshot(sessionA.id)).includes("/acl-complete") ? true : null),
        waitFor("source B ACL completion", async () => (await readTerminalBenchmarkSnapshot(sessionB.id)).includes("/acl-complete") ? true : null),
      ]);
      const aclSnapshotA = await readTerminalBenchmarkSnapshot(sessionA.id);
      const aclSnapshotB = await readTerminalBenchmarkSnapshot(sessionB.id);
      const privilegeUnexpectedSuccesses = occurrences(aclSnapshotA + aclSnapshotB, "/unexpected-success");

      await writeTerminalBenchmark(sessionA.id, "\u0003");
      await waitForSettled(sessionA.id);
      await previewRefresh(sourceA);
      const failedA = await runtimeFor(sourceA, (status) => status.status === "failed" && status.restart.eligible);
      const readyBWhileAFailed = (await previewStatus(sourceB))?.status === "ready";
      useSessionsStore.getState().setActive(sessionA.id);
      useUIStore.getState().setPanelVisible(true);
      useUIStore.getState().setInspectorTab("preview");
      const completeSourceVisible = await waitFor("complete source key", () => {
        const text = document.body.innerText;
        return [sourceA.repositoryId, sourceA.worktreeId, sourceA.workspaceId, sourceA.sessionId, sourceA.terminalId,
          sourceA.restartProvenance?.generation, String(sourceA.physicalPtyId), urlA]
          .every((value) => value && text.includes(value)) ? true : null;
      });
      const viewTerminal = await waitFor("View source terminal action", () => document.querySelector<HTMLButtonElement>('button[data-preview-action="view-source-terminal"]'));
      viewTerminal.click();
      const viewTerminalFocused = await waitFor("source terminal focus", () => useSessionsStore.getState().activeSessionId === sessionA.id
        && !useUIStore.getState().panelVisible
        && document.activeElement?.classList.contains("xterm-helper-textarea") ? true : null);
      useUIStore.getState().setPanelVisible(true);
      useUIStore.getState().setInspectorTab("preview");

      const crossSourceRejected = await rejected(() => previewRestartPrepare({ ...sourceA, restartProvenance: sourceB.restartProvenance }));
      const beforePrepareA = await readTerminalBenchmarkSnapshot(sessionA.id);
      const beforePrepareB = await readTerminalBenchmarkSnapshot(sessionB.id);
      const servingBefore = occurrences(beforePrepareA, "Serving HTTP on");
      const prepareButton = await waitFor("enabled restart prepare action", () => {
        const button = document.querySelector<HTMLButtonElement>('button[data-preview-action="prepare-restart"]');
        return button && !button.disabled ? button : null;
      });
      prepareButton.click();
      const preparedA = await waitFor("restart command fill", async () => {
        const snapshot = await readTerminalBenchmarkSnapshot(sessionA.id);
        return occurrences(snapshot, commandA) > occurrences(beforePrepareA, commandA) ? snapshot : null;
      });
      const preparedB = await readTerminalBenchmarkSnapshot(sessionB.id);
      const fillOnly = occurrences(preparedA, "Serving HTTP on") === servingBefore
        && (await previewStatus(sourceA))?.status === "failed";
      const sourceBoundFill = preparedB === beforePrepareB;
      await writeTerminalBenchmark(sessionA.id, "\n");
      const recoveredSourceA = await sourceFor(sessionA.id, urlA, sourceA.restartProvenance?.generation);
      await runtimeFor(recoveredSourceA, (status) => status.status === "failed" || status.status === "ready");
      await previewRefresh(recoveredSourceA);
      const recoveredA = await runtimeFor(recoveredSourceA, (status) => status.status === "ready" && status.restart.reason === "not-failed");
      const oldGenerationRejected = await rejected(() => previewRestartPrepare(sourceA));
      await previewClose(recoveredSourceA);
      await previewOpen(recoveredSourceA);
      const reopenedReady = Boolean(await runtimeFor(recoveredSourceA, (status) => status.status === "ready" && status.restart.reason === "not-failed"));

      await writeTerminalBenchmark(sessionA.id, "\u0003");
      await waitForSettled(sessionA.id);
      await previewRefresh(recoveredSourceA);
      await runtimeFor(recoveredSourceA, (status) => status.status === "failed" && status.restart.eligible);
      await writeTerminalBenchmark(sessionA.id, "echo restart-untrusted\n");
      await waitFor("untrusted command provenance", () => {
        const session = useSessionsStore.getState().sessions.find((candidate) => candidate.id === sessionA.id);
        return session?.previewCommandProvenance?.command === "echo restart-untrusted" && session.runState !== "running" ? true : null;
      });
      const unprovenStatus = await runtimeFor(recoveredSourceA, (status) => status.status === "failed" && status.restart.reason === "provenance-changed");
      const unprovenRejected = await rejected(() => previewRestartPrepare(recoveredSourceA));

      await writeTerminalBenchmark(sessionB.id, "\u0003");
      await waitForSettled(sessionB.id);
      await previewRefresh(sourceB);
      await runtimeFor(sourceB, (status) => status.status === "failed" && status.restart.eligible);
      await writeTerminalBenchmark(sessionB.id, "exit\n");
      const terminalExited = await waitFor("terminal B exit", () => {
        const session = useSessionsStore.getState().sessions.find((candidate) => candidate.id === sessionB.id);
        return session && session.ptyId === undefined && session.previewSources?.every((source) => source.state === "stale") ? true : null;
      });
      const terminalExitRejected = await rejected(() => previewRestartPrepare(sourceB));
      if (cancelled) return;
      const report = {
        benchmark: "phase3-preview-restart",
        twoResolvedWorktrees: sourceA.worktreeId !== sourceB.worktreeId && sourceA.workspaceId !== sourceB.workspaceId,
        twoPhysicalPtys: sourceA.physicalPtyId !== sourceB.physicalPtyId,
        aclCompleted: Boolean(aclA && aclB),
        privilegeUnexpectedSuccesses,
        completeSourceVisible: Boolean(completeSourceVisible),
        viewTerminalFocused: Boolean(viewTerminalFocused),
        failedAEligible: failedA.restart.reason === "ready",
        readyBWhileAFailed,
        crossSourceRejected,
        fillOnly,
        sourceBoundFill,
        recoveredReady: recoveredA.status === "ready",
        oldGenerationRejected,
        reopenedReady,
        unprovenReason: unprovenStatus.restart.reason,
        unprovenRejected,
        terminalExited: Boolean(terminalExited),
        terminalExitRejected,
      };
      const passed = Object.entries(report).every(([key, value]) => {
        if (key === "benchmark") return true;
        if (key === "privilegeUnexpectedSuccesses") return value === 0;
        if (key === "unprovenReason") return value === "provenance-changed";
        return value === true;
      });
      await info(`[benchmark:phase3-restart] ${JSON.stringify({ ...report, passed })}`);
    })().catch(async (reason) => {
      await logError(`[benchmark:phase3-restart] ${JSON.stringify({ benchmark: "phase3-preview-restart", passed: false, error: String(reason) })}`);
    });
    return () => { cancelled = true; };
  }, [ready]);
}
