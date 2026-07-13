import { invoke } from "@tauri-apps/api/core";
import type { PreviewCommandProvenance, PreviewSource, PreviewSourceContext } from "./preview-source.ts";

const terminalCommandSync = new Map<string, Promise<void>>();

function queueTerminalCommandSync(context: PreviewSourceContext, action: () => Promise<void>): Promise<void> {
  const previous = terminalCommandSync.get(context.terminalId) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(action);
  terminalCommandSync.set(context.terminalId, current);
  void current.finally(() => {
    if (terminalCommandSync.get(context.terminalId) === current) terminalCommandSync.delete(context.terminalId);
  }).catch(() => {});
  return current;
}

export function previewOpen(source: PreviewSource): Promise<string> {
  return invoke<string>("preview_open", { source });
}

export type PreviewTunnelStatus = "opening" | "ready" | "failed";

export interface PreviewTunnelState {
  status: PreviewTunnelStatus;
  remotePort: number;
  localEndpoint?: string;
  previewSource?: PreviewSource;
  reason?: string;
}

export function previewRemoteSourceObserved(source: PreviewSource): Promise<void> {
  return invoke<void>("preview_remote_source_observed", { source });
}

export function previewTunnelOpen(source: PreviewSource, actionNonce: string): Promise<PreviewTunnelState> {
  return invoke<PreviewTunnelState>("preview_tunnel_open", { source, actionNonce });
}

export function previewTunnelStatus(source: PreviewSource): Promise<PreviewTunnelState | null> {
  return invoke<PreviewTunnelState | null>("preview_tunnel_status", { source });
}

export function previewTunnelClose(source: PreviewSource): Promise<void> {
  return invoke<void>("preview_tunnel_close", { source });
}

export function previewActionNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function previewRefresh(source: PreviewSource): Promise<void> {
  return invoke<void>("preview_refresh", { source });
}

export function previewClose(source: PreviewSource): Promise<void> {
  return invoke<void>("preview_close", { source });
}

export type PreviewRuntimeStatus = "opening" | "loading" | "ready" | "failed";

export interface PreviewRuntimeState {
  status: PreviewRuntimeStatus;
  currentUrl: string;
  canGoBack: boolean;
  canGoForward: boolean;
  zoomFactor: number;
  viewport: {
    mode: "preset" | "fit" | "reset";
    requestedWidth: number;
    requestedHeight: number;
    actualWidth: number;
    actualHeight: number;
    outerWidth: number;
    outerHeight: number;
    exact: boolean;
  };
  telemetry: {
    generation: number;
    events: Array<{ kind: "console-error" | "unhandled-error" | "network-failure"; message: string; count: number }>;
    dropped: number;
    text: string;
  };
  restart: {
    eligible: boolean;
    command?: string;
    reason: "not-failed" | "source-stale" | "pty-exited" | "command-unavailable" | "provenance-changed" | "terminal-busy" | "already-prepared" | "ready";
  };
}

export function previewStatus(source: PreviewSource): Promise<PreviewRuntimeState | null> {
  return invoke<PreviewRuntimeState | null>("preview_status", { source });
}

export function previewNavigate(source: PreviewSource, address: string): Promise<void> {
  return invoke<void>("preview_navigate", { source, address });
}

export function previewGoBack(source: PreviewSource): Promise<void> {
  return invoke<void>("preview_go_back", { source });
}

export function previewGoForward(source: PreviewSource): Promise<void> {
  return invoke<void>("preview_go_forward", { source });
}

export function previewSetZoom(source: PreviewSource, factor: number): Promise<void> {
  return invoke<void>("preview_set_zoom", { source, factor });
}

export function previewResetZoom(source: PreviewSource): Promise<void> {
  return invoke<void>("preview_reset_zoom", { source });
}

export function previewSetViewport(source: PreviewSource, width: number, height: number): Promise<void> {
  return invoke<void>("preview_set_viewport", { source, width, height });
}

export function previewResetViewport(source: PreviewSource): Promise<void> {
  return invoke<void>("preview_reset_viewport", { source });
}

export function previewFitViewport(source: PreviewSource): Promise<void> {
  return invoke<void>("preview_fit_viewport", { source });
}

export function previewTelemetryClear(source: PreviewSource): Promise<void> {
  return invoke<void>("preview_telemetry_clear", { source });
}

export function previewTelemetrySend(source: PreviewSource): Promise<void> {
  return invoke<void>("preview_telemetry_send", { source });
}

export function previewTerminalCommandStarted(context: PreviewSourceContext, provenance: PreviewCommandProvenance): Promise<void> {
  return queueTerminalCommandSync(context, () => invoke<void>("preview_terminal_command_started", { context, provenance }));
}

export function previewTerminalCommandFinished(context: PreviewSourceContext, provenance: PreviewCommandProvenance): Promise<void> {
  return queueTerminalCommandSync(context, () => invoke<void>("preview_terminal_command_finished", { context, provenance }));
}

export function previewTerminalExited(context: PreviewSourceContext): Promise<void> {
  return queueTerminalCommandSync(context, () => invoke<void>("preview_terminal_exited", { context }));
}

export async function previewRestartPrepare(source: PreviewSource): Promise<void> {
  await (terminalCommandSync.get(source.terminalId) ?? Promise.resolve()).catch(() => {});
  return invoke<void>("preview_restart_prepare", { source });
}

export function previewDisplayUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return "<invalid-url>";
  }
}

export function previewBlockReason(source: PreviewSource): "remote" | "stale" | "fallback" | null {
  if (!((source.transport === "local" && source.permission === "eligible")
    || (source.transport === "ssh" && source.permission === "forwarded"))) return "remote";
  if (source.state !== "active") return "stale";
  if (source.workspaceResolution !== "resolved") return "fallback";
  return null;
}
