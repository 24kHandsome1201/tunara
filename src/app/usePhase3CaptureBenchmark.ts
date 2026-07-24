import { useEffect, useRef } from "react";
import { error as logError, info } from "@tauri-apps/plugin-log";
import { createSession, useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import {
  previewCapture,
  previewClose,
  previewOpen,
  previewSendCaptureToSourceTerminal,
  previewSetViewport,
  previewSetZoom,
  previewStatus,
} from "@/modules/preview/preview-window";
import type { PreviewCaptureResult, PreviewRuntimeState } from "@/modules/preview/preview-window";
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
  throw new Error(`Phase 3 capture benchmark timed out waiting for ${label}`);
}

function shellQuote(value: string): string {
  return `'${value.split("'").join(`'"'"'`)}'`;
}

async function waitForSource(sessionId: string, url: string): Promise<PreviewSource> {
  return waitFor(`source ${new URL(url).port}`, () => {
    const session = useSessionsStore.getState().sessions.find((candidate) => candidate.id === sessionId);
    return session?.previewSources?.find((source) => source.sourceUrl === url
      && source.state === "active"
      && source.workspaceResolution === "resolved"
      && source.physicalPtyId !== undefined);
  });
}

async function waitForReady(source: PreviewSource): Promise<PreviewRuntimeState> {
  return waitFor("ready Preview", async () => {
    const status = await previewStatus(source);
    return status?.status === "ready" ? status : null;
  });
}

async function expectRejected(action: () => Promise<unknown>): Promise<boolean> {
  try {
    await action();
    return false;
  } catch {
    return true;
  }
}

function safeCaptureSummary(capture: PreviewCaptureResult) {
  return {
    captureId: capture.captureId,
    localRef: capture.localRef,
    sourceOrigin: capture.sourceOrigin,
    sourceSummary: capture.sourceSummary,
    capturedAtMs: capture.capturedAtMs,
    viewportCss: [capture.viewportCssWidth, capture.viewportCssHeight],
    zoomFactor: capture.zoomFactor,
    windowGeneration: capture.windowGeneration,
    image: {
      format: capture.imageFormat,
      width: capture.imageWidth,
      height: capture.imageHeight,
      sha256: capture.imageSha256,
    },
  };
}

function pixelsExplainable(capture: PreviewCaptureResult): boolean {
  const scaleX = capture.imageWidth / (capture.viewportCssWidth * capture.zoomFactor);
  const scaleY = capture.imageHeight / (capture.viewportCssHeight * capture.zoomFactor);
  const nearestScale = Math.round((scaleX + scaleY) / 2);
  return nearestScale >= 1
    && nearestScale <= 4
    && Math.abs(scaleX - nearestScale) < 0.01
    && Math.abs(scaleY - nearestScale) < 0.01;
}

export function usePhase3CaptureBenchmark(ready: boolean): void {
  const started = useRef(false);
  useEffect(() => {
    if (TERMINAL_BENCHMARK_VARIANT !== "phase3-capture" || !ready || started.current) return;
    started.current = true;
    let cancelled = false;
    void (async () => {
      const rootA = import.meta.env.VITE_TUNARA_PHASE3_ROOT_A as string | undefined;
      const rootB = import.meta.env.VITE_TUNARA_PHASE3_ROOT_B as string | undefined;
      const urlA = import.meta.env.VITE_TUNARA_PHASE3_URL_A as string | undefined;
      const urlB = import.meta.env.VITE_TUNARA_PHASE3_URL_B as string | undefined;
      if (!rootA || !rootB || !urlA || !urlB) throw new Error("Phase 3 capture benchmark build is missing roots or URLs");

      const sessionA = createSession(rootA, { title: "Phase 3 Capture A" });
      const sessionB = createSession(rootB, { title: "Phase 3 Capture B" });
      useSessionsStore.setState({ sessions: [], activeSessionId: null, launchedSessionIds: {} });
      useUIStore.setState({
        panelVisible: true,
        inspectorTab: "preview",
        overlay: null,
        split: { root: null },
      });
      await delay(0);
      useSessionsStore.getState().addSession(sessionA);
      useSessionsStore.getState().addSession(sessionB);
      useSessionsStore.getState().setActive(sessionA.id);
      const readyIds = await waitForTerminalBenchmarkWriters([sessionA.id, sessionB.id]);
      if (readyIds.length !== 2) throw new Error(`Phase 3 capture benchmark mounted ${readyIds.length}/2 PTYs`);

      await Promise.all([
        writeTerminalBenchmark(sessionA.id, `printf '%s\\n' ${shellQuote(urlA)}\n`),
        writeTerminalBenchmark(sessionB.id, `printf '%s\\n' ${shellQuote(urlB)}\n`),
      ]);
      const [sourceA, sourceB] = await Promise.all([
        waitForSource(sessionA.id, urlA),
        waitForSource(sessionB.id, urlB),
      ]);
      await Promise.all([previewOpen(sourceA), previewOpen(sourceB)]);
      await Promise.all([waitForReady(sourceA), waitForReady(sourceB)]);

      await previewSetViewport(sourceA, 390, 844);
      await previewSetZoom(sourceA, 1.25);
      await previewSetViewport(sourceB, 768, 1024);
      await previewSetZoom(sourceB, 0.9);
      const [statusA, statusB] = await Promise.all([previewStatus(sourceA), previewStatus(sourceB)]);
      const [captureA, captureB] = await Promise.all([previewCapture(sourceA), previewCapture(sourceB)]);

      const snapshotBBefore = await readTerminalBenchmarkSnapshot(sessionB.id);
      const receiptA = await previewSendCaptureToSourceTerminal(sourceA, captureA.captureId);
      const snapshotA = await waitFor("capture A PTY fill", async () => {
        const snapshot = await readTerminalBenchmarkSnapshot(sessionA.id);
        return snapshot.includes(captureA.captureId) ? snapshot : null;
      });
      const crossSourceRejected = await expectRejected(() => previewSendCaptureToSourceTerminal(sourceB, captureA.captureId));
      await writeTerminalBenchmark(sessionA.id, "\u0015");

      await previewClose(sourceA);
      const closedRejected = await expectRejected(() => previewSendCaptureToSourceTerminal(sourceA, captureA.captureId));
      await previewOpen(sourceA);
      await waitForReady(sourceA);
      const reopenedRejected = await expectRejected(() => previewSendCaptureToSourceTerminal(sourceA, captureA.captureId));
      const captureAReopened = await previewCapture(sourceA);
      await Promise.all([previewClose(sourceA), previewClose(sourceB)]);

      if (cancelled) return;
      const report = {
        benchmark: "phase3-preview-capture",
        captures: [safeCaptureSummary(captureA), safeCaptureSummary(captureB), safeCaptureSummary(captureAReopened)],
        viewportA: statusA?.viewport ?? null,
        viewportB: statusB?.viewport ?? null,
        sourcesDistinct: captureA.sourceSummary !== captureB.sourceSummary
          && captureA.sourceOrigin !== captureB.sourceOrigin,
        sourceAOnly: snapshotA.includes(captureA.captureId)
          && !snapshotA.includes(captureB.captureId),
        sourceBBeforeUntouched: !snapshotBBefore.includes(captureA.captureId),
        fillNotExecuted: receiptA.executed === false
          && !snapshotA.includes("command not found")
          && !snapshotA.includes("no matches found"),
        crossSourceRejected,
        closedRejected,
        reopenedRejected,
        generationChanged: captureAReopened.windowGeneration !== captureA.windowGeneration,
        pixelsExplainable: [captureA, captureB, captureAReopened].every(pixelsExplainable),
      };
      const passed = report.sourcesDistinct
        && report.sourceAOnly
        && report.sourceBBeforeUntouched
        && report.fillNotExecuted
        && report.crossSourceRejected
        && report.closedRejected
        && report.reopenedRejected
        && report.generationChanged
        && report.pixelsExplainable
        && captureA.imageFormat === "png"
        && captureB.imageFormat === "png"
        && captureA.imageWidth > 0
        && captureA.imageHeight > 0
        && captureB.imageWidth > 0
        && captureB.imageHeight > 0;
      await info(`[benchmark:phase3-capture] ${JSON.stringify({ ...report, passed })}`);
    })().catch(async (reason) => {
      await logError(`[benchmark:phase3-capture] ${JSON.stringify({ benchmark: "phase3-preview-capture", passed: false, error: String(reason) })}`);
    });
    return () => { cancelled = true; };
  }, [ready]);
}
