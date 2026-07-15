import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { AgentEventHeaderV1 } from "@/modules/agent-events/agent-event-bridge";
import { TimelinePayloadFault, type TimelinePayloadResourceManager, type ValidatedTimelinePayload } from "@/modules/agent-events/payload-resource";
import { useT } from "@/modules/i18n";

const RichRenderer = lazy(() => import("./agent-timeline-rich-renderer").then((module) => ({ default: module.AgentTimelineRichRenderer })));

type PayloadState =
  | { status: "idle" | "loading" }
  | { status: "ready"; payload: ValidatedTimelinePayload }
  | { status: "error"; code: string };

export function AgentTimelinePayload({ header, manager, provenanceKnown, expanded, preloadVisible = true, onExpandedChange }: {
  header: AgentEventHeaderV1;
  manager: TimelinePayloadResourceManager;
  provenanceKnown: boolean;
  expanded: boolean;
  preloadVisible?: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const t = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const expandedRef = useRef(expanded);
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<PayloadState>({ status: "idle" });
  const [requestEpoch, setRequestEpoch] = useState(0);
  expandedRef.current = expanded;

  useEffect(() => {
    const node = hostRef.current;
    const root = node?.closest(".agent-timeline-scroll");
    if (!node || !root || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting && entry.intersectionRatio > 0), { root, threshold: 0.01 });
    observer.observe(node);
    return () => observer.disconnect();
  }, [header.eventId]);

  const shouldLoad = preloadVisible ? visible || expanded : expanded;
  useEffect(() => {
    if (!shouldLoad || !header.payload) {
      setState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setState((current) => current.status === "ready" ? current : { status: "loading" });
    void manager.request(header, { signal: controller.signal, provenanceKnown, priority: expandedRef.current }).then(
      (payload) => { if (!controller.signal.aborted) setState({ status: "ready", payload }); },
      (reason) => {
        if (controller.signal.aborted || (reason instanceof TimelinePayloadFault && reason.code === "aborted")) return;
        setState({ status: "error", code: reason instanceof TimelinePayloadFault ? reason.code : "readFailed" });
      },
    );
    return () => controller.abort();
  }, [header, manager, provenanceKnown, requestEpoch, shouldLoad]);

  const toggle = useCallback(() => {
    if (!expanded && (state.status === "error" || state.status === "idle")) setRequestEpoch((value) => value + 1);
    onExpandedChange(!expanded);
  }, [expanded, onExpandedChange, state.status]);
  useEffect(() => {
    const root = hostRef.current?.closest<HTMLElement>(".agent-timeline-scroll");
    if (!root) return;
    const metrics = manager.snapshot();
    root.dataset.payloadReads = String(metrics.readsStarted);
    root.dataset.payloadCompleted = String(metrics.readsCompleted);
    root.dataset.payloadCacheEntries = String(metrics.cacheEntries);
    root.dataset.payloadCacheBytes = String(metrics.cacheBytes);
    root.dataset.payloadActive = String(metrics.active);
    root.dataset.payloadPeakActive = String(metrics.peakActive);
    root.dataset.payloadStaleDiscarded = String(metrics.staleResultsDiscarded);
  }, [manager, state]);
  if (!header.payload) return null;
  const disabled = !provenanceKnown;
  return (
    <div ref={hostRef} className="agent-timeline-payload" data-payload-state={state.status} data-payload-type={header.payload.contentType} data-expanded={expanded}>
      <button type="button" className="agent-timeline-payload-toggle" aria-expanded={expanded} disabled={disabled} onClick={(event) => { event.stopPropagation(); toggle(); }}>
        <span>{expanded ? t("timeline.payload.collapse") : t("timeline.payload.expand")}</span>
        <span>{header.payload.contentType} · {header.payload.byteLength.toLocaleString()} B</span>
      </button>
      {!provenanceKnown && <div className="agent-timeline-rich-placeholder" role="status">{t("timeline.payload.unknown_source")}</div>}
      {provenanceKnown && expanded && state.status === "loading" && <div className="agent-timeline-rich-placeholder">{t("timeline.payload.loading")}</div>}
      {state.status === "error" && <div className="agent-timeline-rich-placeholder" role="status" data-error-code={state.code}>{t(`timeline.payload.error.${state.code}`)}</div>}
      {expanded && state.status === "ready" && <div className="agent-timeline-rich"><Suspense fallback={<div className="agent-timeline-rich-placeholder">{t("timeline.payload.rendering")}</div>}><RichRenderer payload={state.payload} /></Suspense></div>}
    </div>
  );
}
