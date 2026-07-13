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

export function previewStatus(source: PreviewSource): Promise<PreviewRuntimeStatus | null> {
  return invoke<PreviewRuntimeStatus | null>("preview_status", { source });
}

export function previewBlockReason(source: PreviewSource): "remote" | "stale" | "fallback" | null {
  if (source.transport !== "local" || source.permission !== "eligible") return "remote";
  if (source.state !== "active") return "stale";
  if (source.workspaceResolution !== "resolved") return "fallback";
  return null;
}
