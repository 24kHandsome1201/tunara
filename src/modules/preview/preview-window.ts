import { invoke } from "@tauri-apps/api/core";
import type { PreviewSource } from "./preview-source.ts";

export function previewOpen(source: PreviewSource): Promise<string> {
  return invoke<string>("preview_open", { source });
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

export function previewBlockReason(source: PreviewSource): "remote" | "stale" | "fallback" | null {
  if (source.transport !== "local" || source.permission !== "eligible") return "remote";
  if (source.state !== "active") return "stale";
  if (source.workspaceResolution !== "resolved") return "fallback";
  return null;
}
