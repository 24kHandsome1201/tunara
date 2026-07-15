import { useEffect, useRef } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { LogicalSize } from "@tauri-apps/api/dpi";
import { error as logError, info } from "@tauri-apps/plugin-log";
import { AGENT_EVENT_APPENDED_EVENT, appendAgentEvent, agentEventWorkspaceId, getAgentEventStoreStatus, listAgentEvents } from "@/modules/agent-events/agent-event-bridge";
import { evaluateAnimationFrames, probeTerminalInputEcho, sampleAnimationFrames, TERMINAL_BENCHMARK_VARIANT, waitForTerminalBenchmarkWriters } from "@/modules/terminal/lib/terminal-benchmark";
import { setLanguage } from "@/modules/i18n";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { tryGetCurrentWindow } from "@/ui/lib/current-window";

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitFor<T>(label: string, read: () => T | null | undefined, timeoutMs = 30_000): Promise<T> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const value = read();
    if (value) return value;
    await delay(25);
  }
  throw new Error(`M3 Timeline benchmark timed out waiting for ${label}`);
}

function retainedCount(): number {
  return Number(document.querySelector<HTMLElement>(".agent-timeline-scroll")?.dataset.retainedCount ?? 0);
}

function visibleEventId(): string | null {
  const scroll = document.querySelector<HTMLElement>(".agent-timeline-scroll");
  if (!scroll) return null;
  const top = scroll.getBoundingClientRect().top;
  return [...document.querySelectorAll<HTMLElement>(".agent-timeline-row")]
    .find((row) => row.getBoundingClientRect().bottom > top + 1)?.dataset.eventId ?? null;
}

function payloadMetrics(scroll: HTMLElement) {
  return {
    reads: Number(scroll.dataset.payloadReads ?? 0),
    completed: Number(scroll.dataset.payloadCompleted ?? 0),
    cacheEntries: Number(scroll.dataset.payloadCacheEntries ?? 0),
    cacheBytes: Number(scroll.dataset.payloadCacheBytes ?? 0),
    active: Number(scroll.dataset.payloadActive ?? 0),
    peakActive: Number(scroll.dataset.payloadPeakActive ?? 0),
    staleDiscarded: Number(scroll.dataset.payloadStaleDiscarded ?? 0),
  };
}

async function expandPayloadEvent(scroll: HTMLElement, eventId: string, contentType: string) {
  const findHost = () => document.querySelector<HTMLElement>(`.agent-timeline-row[data-event-id="${eventId}"] .agent-timeline-payload[data-payload-type="${contentType}"]`);
  let host: HTMLElement | null = null;
  for (let top = 0; top <= scroll.scrollHeight; top += Math.max(80, scroll.clientHeight - 40)) {
    scroll.scrollTop = top;
    scroll.dispatchEvent(new Event("scroll", { bubbles: true }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    host = findHost();
    if (host) break;
  }
  if (!host) throw new Error(`M3 Timeline could not render payload ${eventId} (${contentType})`);
  host.scrollIntoView({ block: "center" });
  scroll.dispatchEvent(new Event("scroll", { bubbles: true }));
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  host = findHost();
  const hostBounds = host?.getBoundingClientRect();
  const scrollBounds = scroll.getBoundingClientRect();
  if (!host || !hostBounds || hostBounds.bottom <= scrollBounds.top || hostBounds.top >= scrollBounds.bottom) {
    throw new Error(`M3 Timeline could not place payload ${eventId} inside the viewport`);
  }
  const toggle = host.querySelector<HTMLButtonElement>(".agent-timeline-payload-toggle");
  if (!toggle || toggle.disabled) throw new Error(`M3 Timeline payload toggle unavailable for ${eventId}`);
  toggle.click();
  try {
    host = await waitFor(`expanded payload ${eventId}`, () => {
      const current = findHost();
      return current?.dataset.expanded === "true" && current.dataset.payloadState === "ready" && current.querySelector(".agent-timeline-rich") ? current : null;
    });
  } catch (reason) {
    const current = findHost();
    throw Object.assign(new Error(`${String(reason)}; state=${current?.dataset.payloadState ?? "unmounted"}; expanded=${current?.dataset.expanded ?? "unmounted"}; error=${current?.querySelector<HTMLElement>("[data-error-code]")?.dataset.errorCode ?? "none"}; metrics=${JSON.stringify(payloadMetrics(scroll))}`), { cause: reason });
  }
  if (contentType.startsWith("image/")) {
    await waitFor(`decoded local image ${eventId}`, () => findHost()?.querySelector<HTMLImageElement>(".agent-timeline-rich-image"), 5_000);
    host = findHost() ?? host;
  }
  await delay(80);
  const result = {
    eventId,
    contentType,
    richDomRows: Math.max(host.querySelectorAll(".agent-timeline-code-line").length, host.querySelectorAll(".agent-timeline-diff > span").length, host.querySelectorAll(".agent-timeline-markdown > div").length),
    imageDecoded: Boolean(host.querySelector(".agent-timeline-rich-image")),
    horizontalOverflow: [...host.querySelectorAll<HTMLElement>(".agent-timeline-rich, .agent-timeline-rich > *, .agent-timeline-rich-image")].some((node) => node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflowX !== "auto"),
  };
  host.querySelector<HTMLButtonElement>(".agent-timeline-payload-toggle")?.click();
  await waitFor(`collapsed payload ${eventId}`, () => findHost()?.dataset.expanded === "false" ? true : null);
  return result;
}

async function loadOlderPages(count: number) {
  for (let index = 0; index < count; index += 1) {
    const before = retainedCount();
    const button = await waitFor("enabled Older button", () => { const candidate = document.querySelector<HTMLButtonElement>("[data-timeline-action='older']"); return candidate && !candidate.disabled ? candidate : null; });
    button.click();
    await waitFor("next rich payload page", () => retainedCount() > before || document.querySelector("[data-timeline-action='latest']") ? true : null);
    await delay(40);
  }
}

async function sampleRapidScroll(scroll: HTMLElement) {
  const framePromise = sampleAnimationFrames(2_000);
  for (let index = 0; index < 120; index += 1) {
    scroll.scrollTop = index % 2 === 0 ? Math.max(0, scroll.scrollHeight - scroll.clientHeight) : Math.round(scroll.scrollHeight * ((index % 11) / 11));
    scroll.dispatchEvent(new Event("scroll", { bubbles: true }));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  return evaluateAnimationFrames(await framePromise, 33.4, 60);
}

export function usePhase4TimelineBenchmark(ready: boolean): void {
  const started = useRef(false);
  useEffect(() => {
    if (TERMINAL_BENCHMARK_VARIANT !== "m3-timeline" || !ready || started.current) return;
    started.current = true;
    let cancelled = false;
    void (async () => {
      const sessions = useSessionsStore.getState().sessions.filter((session) => session.id === "m3-timeline-a" || session.id === "m3-timeline-b");
      if (sessions.length !== 2) throw new Error("M3 Timeline benchmark requires two restored task sessions");
      const benchmarkWindow = tryGetCurrentWindow();
      if (benchmarkWindow) { await benchmarkWindow.show(); await benchmarkWindow.setFocus(); }
      setLanguage("en");
      useSessionsStore.setState({ activeSessionId: "m3-timeline-a", launchedSessionIds: { "m3-timeline-a": true, "m3-timeline-b": true } });
      useUIStore.setState({ sidebarVisible: false, panelVisible: true, inspectorTab: "timeline", overlay: null, split: { mode: "single", paneA: null, paneB: null, ratio: 0.5 } });
      const openStartedAt = performance.now();
      const readyIds = await waitForTerminalBenchmarkWriters(["m3-timeline-a", "m3-timeline-b"]);
      if (readyIds.length !== 2) throw new Error(`M3 Timeline mounted ${readyIds.length}/2 PTYs`);
      const hydratedSession = await waitFor("workspace hydration", () => useSessionsStore.getState().sessions.find((session) => session.id === "m3-timeline-a" && session.workspace));
      const preflightWorkspaceId = await agentEventWorkspaceId(hydratedSession.workspace!.repository.id);
      const preflightStatus = await getAgentEventStoreStatus();
      const preflightPage = preflightStatus.capability === "enabled"
        ? await listAgentEvents({ scope: { type: "task", workspaceId: preflightWorkspaceId, taskId: hydratedSession.id }, limit: 1 })
        : null;
      await info(`[benchmark:m3-timeline:preflight] ${JSON.stringify({ status: preflightStatus, workspaceId: preflightWorkspaceId, firstEventId: preflightPage?.items[0]?.eventId ?? null })}`);
      if (!preflightPage?.items.length) throw new Error(`M3 Timeline preflight found no scoped headers: ${JSON.stringify({ capability: preflightStatus.capability, eventCount: preflightStatus.eventCount, errorCode: preflightStatus.errorCode, dataLocation: preflightStatus.dataLocation, workspaceId: preflightWorkspaceId })}`);
      let scroll = await waitFor("Timeline viewport", () => document.querySelector<HTMLElement>(".agent-timeline-scroll"));
      await waitFor("initial virtual rows", () => document.querySelector(".agent-timeline-row"));
      await info("[benchmark:m3-timeline:stage] initial-rows");
      const firstOpenMs = Math.round((performance.now() - openStartedAt) * 100) / 100;
      await delay(120);
      const initialPayloadMetrics = payloadMetrics(scroll);
      const initial = { retained: retainedCount(), domRows: document.querySelectorAll(".agent-timeline-row").length, privatePayloadVisible: Boolean(document.querySelector(".agent-timeline-rich")), payload: initialPayloadMetrics };
      const ptyBeforeMs = await probeTerminalInputEcho("m3-timeline-a", `__TUNARA_M3_BEFORE_${Date.now().toString(36)}__`);
      await info("[benchmark:m3-timeline:stage] pty-before");

      scroll.scrollTop = 300;
      scroll.dispatchEvent(new Event("scroll", { bubbles: true }));
      await delay(50);
      const anchorBefore = visibleEventId();
      const scrollBefore = scroll.scrollTop;
      const older = await waitFor("Older button", () => document.querySelector<HTMLButtonElement>("[data-timeline-action='older']"));
      older.click();
      await waitFor("second page", () => retainedCount() >= 200 ? retainedCount() : null);
      await delay(100);
      await info("[benchmark:m3-timeline:stage] second-page");
      const anchorAfter = visibleEventId();
      const pagination = { anchorBefore, anchorAfter, anchorPreserved: anchorBefore === anchorAfter, scrollDeltaPx: Math.round(scroll.scrollTop - scrollBefore) };

      const imagePayload = await expandPayloadEvent(scroll, "ae-00000000000000009000", "image/png");
      await loadOlderPages(1);
      const diffPayload = await expandPayloadEvent(scroll, "ae-00000000000000008900", "text/x-diff");
      await loadOlderPages(2);
      const toolPayload = await expandPayloadEvent(scroll, "ae-00000000000000008700", "text/plain");
      await loadOlderPages(5);
      const markdownPayload = await expandPayloadEvent(scroll, "ae-00000000000000008200", "text/markdown");
      const richPayloads = { image: imagePayload, diff: diffPayload, tool: toolPayload, markdown: markdownPayload, metrics: payloadMetrics(scroll) };

      while (retainedCount() < 600) {
        const button = await waitFor("enabled Older button", () => { const candidate = document.querySelector<HTMLButtonElement>("[data-timeline-action='older']"); return candidate && !candidate.disabled ? candidate : null; });
        button.click();
        const prior = retainedCount();
        await waitFor("next retained page", () => retainedCount() > prior ? retainedCount() : null);
      }
      const retentionEdge = await waitFor("retention edge Older button", () => { const candidate = document.querySelector<HTMLButtonElement>("[data-timeline-action='older']"); return candidate && !candidate.disabled ? candidate : null; });
      retentionEdge.click();
      await waitFor("Latest button after retention edge", () => document.querySelector<HTMLButtonElement>("[data-timeline-action='latest']"));
      await info("[benchmark:m3-timeline:stage] retention-edge");
      const rapidScroll = await sampleRapidScroll(scroll);
      const latest = await waitFor("Latest button", () => document.querySelector<HTMLButtonElement>("[data-timeline-action='latest']"));
      latest.click();
      await waitFor("latest page reset", () => retainedCount() === 100 ? true : null);
      await delay(120);
      scroll = await waitFor("reloaded Timeline viewport", () => document.querySelector<HTMLElement>(".agent-timeline-scroll"));
      await info("[benchmark:m3-timeline:stage] latest-reset");
      scroll.scrollTop = 0;
      scroll.dispatchEvent(new Event("scroll", { bubbles: true }));
      await delay(100);
      if (scroll.scrollTop > 1) throw new Error(`M3 Timeline failed to hold the explicit up-scroll position: ${scroll.scrollTop}`);
      const appendScrollTop = scroll.scrollTop;

      const active = useSessionsStore.getState().sessions.find((session) => session.id === "m3-timeline-a");
      if (!active?.workspace) throw new Error("workspace hydration did not complete");
      const workspaceId = await agentEventWorkspaceId(active.workspace.repository.id);
      let observedAppendEventId: string | null = null;
      const unlistenAppendProbe = await listen<{ eventId?: string }>(AGENT_EVENT_APPENDED_EVENT, (event) => { observedAppendEventId = event.payload.eventId ?? null; });
      const appended = await appendAgentEvent({ clientEventId: `benchmark-live-${Date.now()}`, workspaceId, taskId: active.id, sessionId: active.id, kind: "output_summary", source: "system", summary: "Streaming final summary / 流式摘要完成" });
      await waitFor("native append event", () => observedAppendEventId === appended.header.eventId ? true : null, 5_000);
      unlistenAppendProbe();
      await info("[benchmark:m3-timeline:stage] native-append-event");
      await delay(250);
      const appendViewport = document.querySelector<HTMLElement>(".agent-timeline-scroll");
      await info(`[benchmark:m3-timeline:append-state] ${JSON.stringify({ retained: retainedCount(), unread: appendViewport?.dataset.unread ?? null, scrollTop: appendViewport?.scrollTop ?? null, clientHeight: appendViewport?.clientHeight ?? null, scrollHeight: appendViewport?.scrollHeight ?? null, totalSize: appendViewport?.dataset.totalSize ?? null })}`);
      await waitFor("unread append", () => document.querySelector<HTMLElement>(".agent-timeline-scroll")?.dataset.unread === "1" ? true : null, 5_000);
      await info("[benchmark:m3-timeline:stage] unread-append");
      const appendDidNotSteal = Math.abs(scroll.scrollTop - appendScrollTop) < 2;
      const unreadButton = await waitFor("Unread button", () => document.querySelector<HTMLButtonElement>("[data-timeline-action='unread']"));
      unreadButton.click();
      await waitFor("bottom after unread", () => { const current = document.querySelector<HTMLElement>(".agent-timeline-scroll"); return current && current.dataset.unread === "0" && current.scrollHeight - (current.scrollTop + current.clientHeight) <= 40 ? true : null; });
      const streamBase = appended.header;
      await Promise.all(Array.from({ length: 120 }, (_, index) => emit(AGENT_EVENT_APPENDED_EVENT, { ...streamBase, summary: `Streaming chunk ${index}` })));
      await emit(AGENT_EVENT_APPENDED_EVENT, { ...streamBase, summary: "Streaming final summary / 流式摘要完成" });
      await waitFor("streaming final summary", () => document.body.innerText.includes("Streaming final summary") ? true : null);
      await info("[benchmark:m3-timeline:stage] streaming-final");
      const streamingDomRows = document.querySelectorAll(".agent-timeline-row").length;
      await delay(500);
      const streamingSolidified = !document.querySelector(`[data-event-id="${streamBase.eventId}"][data-streaming="true"]`);

      useSessionsStore.getState().setActive("m3-timeline-b");
      await waitFor("task B timeline", () => document.querySelector<HTMLElement>(".agent-timeline-orientation span[title='m3-timeline-b']"));
      await waitFor("task B rows", () => retainedCount() > 0 ? true : null);
      const taskBRetained = retainedCount();
      useSessionsStore.getState().setActive("m3-timeline-a");
      await waitFor("task A restored", () => document.querySelector<HTMLElement>(".agent-timeline-orientation span[title='m3-timeline-a']"));
      await waitFor("task A rows restored", () => retainedCount() > 0 ? document.querySelector<HTMLElement>(".agent-timeline-scroll") : null);
      await info("[benchmark:m3-timeline:stage] task-switch");
      const taskSwitch = { taskBRetained, taskARestoredScroll: Math.round(document.querySelector<HTMLElement>(".agent-timeline-scroll")?.scrollTop ?? -1) };

      setLanguage("zh-CN");
      const chineseVisible = await waitFor("Chinese Timeline title", () => document.querySelector<HTMLElement>(".agent-timeline-kicker")?.textContent === "Agent 时间线" ? true : null);
      setLanguage("en");
      const englishVisible = await waitFor("English Timeline title", () => document.querySelector<HTMLElement>(".agent-timeline-kicker")?.textContent === "Agent Timeline" ? true : null);
      const win = tryGetCurrentWindow();
      const viewports = [];
      if (win) {
        await win.setMinSize(new LogicalSize(400, 300));
        for (const [width, height] of [[576, 433], [640, 480], [1200, 800]]) {
          await win.setSize(new LogicalSize(width, height)); await delay(180);
          const size = await win.innerSize();
          const overflow = [...document.querySelectorAll<HTMLElement>(".agent-timeline, .agent-timeline-header, .agent-timeline-row")].some((node) => node.scrollWidth > node.clientWidth + 1);
          viewports.push({ requested: `${width}x${height}`, actual: `${size.width}x${size.height}`, overflow });
        }
      }
      await info("[benchmark:m3-timeline:stage] viewports");
      let foregroundMs: number | null = null;
      if (win) {
        await win.hide(); await delay(250);
        const foregroundStarted = performance.now(); await win.show(); await win.setFocus();
        await waitFor("foreground Timeline", () => document.querySelector(".agent-timeline-row"));
        foregroundMs = Math.round((performance.now() - foregroundStarted) * 100) / 100;
      }
      const ptyAfterMs = await probeTerminalInputEcho("m3-timeline-a", `__TUNARA_M3_AFTER_${Date.now().toString(36)}__`);
      if (cancelled) return;
      const finalDomRows = document.querySelectorAll(".agent-timeline-row").length;
      const report = {
        benchmark: "m3-agent-timeline-ui",
        timestamp: new Date().toISOString(),
        fixtureHeaders: 10_000,
        firstOpenMs,
        initial,
        pagination,
        richPayloads,
        rapidScroll,
        retainedHeaders: retainedCount(),
        domRows: { final: finalDomRows, streaming: streamingDomRows, bounded: finalDomRows < 40 && streamingDomRows < 40 },
        streaming: { appendDidNotSteal, solidified: streamingSolidified },
        taskSwitch,
        locale: { chineseVisible, englishVisible },
        viewports,
        foregroundMs,
        pty: { beforeMs: Math.round(ptyBeforeMs * 100) / 100, afterMs: Math.round(ptyAfterMs * 100) / 100, unaffected: ptyAfterMs < 250 },
      };
      const richPassed = richPayloads.image.imageDecoded
        && richPayloads.diff.richDomRows <= 600
        && richPayloads.tool.richDomRows <= 600
        && richPayloads.markdown.richDomRows <= 600
        && !richPayloads.image.horizontalOverflow
        && !richPayloads.diff.horizontalOverflow
        && !richPayloads.tool.horizontalOverflow
        && !richPayloads.markdown.horizontalOverflow
        && richPayloads.metrics.cacheEntries <= 24
        && richPayloads.metrics.cacheBytes <= 6 * 1024 * 1024
        && richPayloads.metrics.peakActive <= 4;
      await info(`[benchmark:m3-timeline] ${JSON.stringify({ ...report, passed: initial.retained === 100 && !initial.privatePayloadVisible && initial.payload.reads <= initial.domRows && pagination.anchorPreserved && richPassed && rapidScroll.passed && report.domRows.bounded && streamingSolidified && appendDidNotSteal && taskBRetained > 0 && chineseVisible && englishVisible && viewports.every((viewport) => !viewport.overflow) && report.pty.unaffected })}`);
    })().catch(async (reason) => { await logError(`[benchmark:m3-timeline] ${JSON.stringify({ benchmark: "m3-agent-timeline-ui", passed: false, error: String(reason) })}`); });
    return () => { cancelled = true; };
  }, [ready]);
}
