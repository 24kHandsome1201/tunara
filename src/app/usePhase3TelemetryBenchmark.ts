import { useEffect, useRef } from "react";
import { error as logError, info } from "@tauri-apps/plugin-log";
import { createSession, useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import {
  previewClose,
  previewOpen,
  previewStatus,
  previewTelemetryClear,
  previewTelemetrySend,
} from "@/modules/preview/preview-window";
import type { PreviewSource } from "@/modules/preview/preview-source";
import {
  readTerminalBenchmarkSnapshot,
  TERMINAL_BENCHMARK_VARIANT,
  waitForTerminalBenchmarkWriters,
  writeTerminalBenchmark,
} from "@/modules/terminal/lib/terminal-benchmark";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(label: string, read: () => T | null | undefined | Promise<T | null | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Phase 3 telemetry benchmark timed out waiting for ${label}`);
}

function fixturePort(url: string): string {
  return new URL(url).port;
}

function shellQuote(value: string): string {
  return `'${value.split("'").join(`'"'"'`)}'`;
}

async function waitForSource(sessionId: string, url: string): Promise<PreviewSource> {
  return waitFor(`source ${fixturePort(url)}`, () => {
    const session = useSessionsStore.getState().sessions.find((candidate) => candidate.id === sessionId);
    return session?.previewSources?.find((source) => source.sourceUrl === url
      && source.state === "active"
      && source.workspaceResolution === "resolved"
      && source.physicalPtyId !== undefined);
  });
}

async function waitForFailures(source: PreviewSource, marker: string, generationAfter = 0) {
  const deadline = Date.now() + 20_000;
  let observedKinds: string[] = [];
  while (Date.now() < deadline) {
    const status = await previewStatus(source);
    if (!status || status.telemetry.generation <= generationAfter) {
      await delay(100);
      continue;
    }
    observedKinds = status.telemetry.events.map((event) => event.kind);
    const joined = status.telemetry.events.map((event) => event.message).join(" ");
    if (joined.includes(`FIXTURE_CONSOLE_${marker}`)
      && joined.includes(`FIXTURE_UNHANDLED_${marker}`)
      && joined.includes("GET /status-failure · HTTP 503 · fetch")) return status;
    await delay(100);
  }
  throw new Error(`Phase 3 telemetry benchmark timed out waiting for failures ${marker}; observed kinds=${observedKinds.join(",") || "none"}`);
}

export function usePhase3TelemetryBenchmark(ready: boolean): void {
  const started = useRef(false);
  useEffect(() => {
    if (TERMINAL_BENCHMARK_VARIANT !== "phase3-telemetry" || !ready || started.current) return;
    started.current = true;
    let cancelled = false;
    void (async () => {
      const rootA = import.meta.env.VITE_TUNARA_PHASE3_ROOT_A as string | undefined;
      const rootB = import.meta.env.VITE_TUNARA_PHASE3_ROOT_B as string | undefined;
      const urlA = import.meta.env.VITE_TUNARA_PHASE3_URL_A as string | undefined;
      const urlB = import.meta.env.VITE_TUNARA_PHASE3_URL_B as string | undefined;
      if (!rootA || !rootB || !urlA || !urlB) throw new Error("Phase 3 telemetry benchmark build is missing roots or URLs");
      const sessionA = createSession(rootA, { title: "Phase 3 A" });
      const sessionB = createSession(rootB, { title: "Phase 3 B" });
      useSessionsStore.setState({
        sessions: [],
        activeSessionId: null,
        launchedSessionIds: {},
      });
      useUIStore.setState({
        panelVisible: true,
        inspectorTab: "preview",
        overlay: null,
        split: { mode: "single", paneA: null, paneB: null, ratio: 0.5 },
      });
      await delay(0);
      useSessionsStore.getState().addSession(sessionA);
      useSessionsStore.getState().addSession(sessionB);
      useSessionsStore.getState().setActive(sessionA.id);
      const readyIds = await waitForTerminalBenchmarkWriters([sessionA.id, sessionB.id]);
      if (readyIds.length !== 2) throw new Error(`Phase 3 telemetry benchmark mounted ${readyIds.length}/2 PTYs`);
      await Promise.all([
        writeTerminalBenchmark(sessionA.id, `printf '%s\\n' ${shellQuote(urlA)}\n`),
        writeTerminalBenchmark(sessionB.id, `printf '%s\\n' ${shellQuote(urlB)}\n`),
      ]);
      const [sourceA, sourceB] = await Promise.all([
        waitForSource(sessionA.id, urlA),
        waitForSource(sessionB.id, urlB),
      ]);
      await Promise.all([previewOpen(sourceA), previewOpen(sourceB)]);
      const [statusA, statusB] = await Promise.all([
        waitForFailures(sourceA, fixturePort(urlA)),
        waitForFailures(sourceB, fixturePort(urlB)),
      ]);
      useSessionsStore.getState().setActive(sessionA.id);
      const inspectorVisible = await waitFor("Inspector summary", () => {
        const text = document.body.innerText;
        return text.includes(`FIXTURE_CONSOLE_${fixturePort(urlA)}`)
          && text.includes("GET /status-failure · HTTP 503 · fetch")
          && !text.includes("fixture-private")
          && !text.includes("/Users/fixture")
          ? true : null;
      });
      await previewTelemetrySend(sourceA);
      const snapshotA = await waitFor("source A PTY fill", async () => {
        const snapshot = await readTerminalBenchmarkSnapshot(sessionA.id);
        return snapshot.includes(`FIXTURE_CONSOLE_${fixturePort(urlA)}`) ? snapshot : null;
      });
      const snapshotBBefore = await readTerminalBenchmarkSnapshot(sessionB.id);
      await writeTerminalBenchmark(sessionA.id, "\u0015");
      await previewTelemetrySend(sourceB);
      const snapshotB = await waitFor("source B PTY fill", async () => {
        const snapshot = await readTerminalBenchmarkSnapshot(sessionB.id);
        return snapshot.includes(`FIXTURE_CONSOLE_${fixturePort(urlB)}`) ? snapshot : null;
      });
      await writeTerminalBenchmark(sessionB.id, "\u0015");
      await previewTelemetryClear(sourceA);
      const cleared = await waitFor("cleared summary", async () => (await previewStatus(sourceA))?.telemetry.events.length === 0 || null);
      const generationA = statusA.telemetry.generation;
      await previewClose(sourceA);
      await previewOpen(sourceA);
      const reopenedA = await waitForFailures(sourceA, fixturePort(urlA), generationA);
      await Promise.all([previewClose(sourceA), previewClose(sourceB)]);
      if (cancelled) return;
      const report = {
        benchmark: "phase3-preview-telemetry",
        ports: [fixturePort(urlA), fixturePort(urlB)],
        failuresA: statusA.telemetry.events.map((event) => event.kind),
        failuresB: statusB.telemetry.events.map((event) => event.kind),
        inspectorVisible,
        sourceAOnly: snapshotA.includes(`FIXTURE_CONSOLE_${fixturePort(urlA)}`)
          && !snapshotA.includes(`FIXTURE_CONSOLE_${fixturePort(urlB)}`),
        sourceBBeforeUntouched: !snapshotBBefore.includes(`FIXTURE_CONSOLE_${fixturePort(urlA)}`),
        sourceBOnly: snapshotB.includes(`FIXTURE_CONSOLE_${fixturePort(urlB)}`)
          && !snapshotB.includes(`FIXTURE_CONSOLE_${fixturePort(urlA)}`),
        sourceAFillNotExecuted: !snapshotA.includes("command not found") && !snapshotA.includes("no matches found"),
        sourceBFillNotExecuted: !snapshotB.includes("command not found") && !snapshotB.includes("no matches found"),
        cleared: Boolean(cleared),
        generationChanged: reopenedA.telemetry.generation > generationA,
        reopenedIsolated: reopenedA.telemetry.events.every((event) => !event.message.includes(fixturePort(urlB))),
      };
      await info(`[benchmark:phase3-telemetry] ${JSON.stringify({ ...report, passed: Object.values(report).every((value) => value !== false) })}`);
    })().catch(async (reason) => {
      await logError(`[benchmark:phase3-telemetry] ${JSON.stringify({ benchmark: "phase3-preview-telemetry", passed: false, error: String(reason) })}`);
    });
    return () => { cancelled = true; };
  }, [ready]);
}
