import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export const AGENT_EVENT_PAGE_SIZE = 100;
export const AGENT_EVENT_MAX_PAGE_SIZE = 200;
export const AGENT_EVENT_APPENDED_EVENT = "agent-event://appended";

export function isAgentTimelineFeatureEnabled(): boolean {
  const configured = typeof import.meta.env !== "undefined" ? import.meta.env.VITE_TUNARA_AGENT_TIMELINE : undefined;
  return configured !== "0" && configured !== "false";
}

/** Event Store identifiers are deliberately path-opaque. Repository identity
 * may contain canonical paths, so callers must share this stable mapping. */
export async function agentEventWorkspaceId(repositoryIdentity: string): Promise<string> {
  const input = new TextEncoder().encode(repositoryIdentity);
  const digest = await crypto.subtle.digest("SHA-256", input);
  const hex = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `ws-${hex}`;
}

export type AgentEventKind =
  | "user_input"
  | "agent_status"
  | "output_summary"
  | "tool_call"
  | "file_change"
  | "test_result"
  | "confirmation_request"
  | "preview_evidence"
  | "journal_reference";

export type AgentEventSource =
  | "hook"
  | "process"
  | "shell_integration"
  | "heuristic"
  | "user"
  | "system";

export interface AgentEventPayloadMetaV1 {
  state: "available";
  contentType: string;
  byteLength: number;
  sha256: string;
}

/**
 * Stable, lightweight list row. Private command/prompt/output/file bodies are
 * forbidden here and are only available through readAgentEventPayload().
 */
export interface AgentEventHeaderV1 {
  schemaVersion: 1;
  sequence: number;
  eventId: string;
  clientEventId: string;
  workspaceId: string;
  taskId: string;
  sessionId?: string | null;
  kind: AgentEventKind;
  source: AgentEventSource;
  occurredAtMs: number;
  recordedAtMs: number;
  summary: string;
  payload?: AgentEventPayloadMetaV1 | null;
}

export interface AgentEventPrivatePayloadInput {
  contentType: "text/plain" | "text/markdown" | "application/json" | "text/x-diff";
  body: string;
}

export interface AgentEventAppendRequest {
  clientEventId: string;
  workspaceId: string;
  taskId: string;
  sessionId?: string | null;
  kind: AgentEventKind;
  source: AgentEventSource;
  occurredAtMs?: number | null;
  summary: string;
  privatePayload?: AgentEventPrivatePayloadInput | null;
}

export interface AgentEventAppendResult {
  status: "appended" | "duplicate";
  header: AgentEventHeaderV1;
}

export type AgentEventQueryScope =
  | { type: "all" }
  | { type: "workspace"; workspaceId: string }
  | { type: "task"; workspaceId: string; taskId: string };

export interface AgentEventListRequest {
  scope: AgentEventQueryScope;
  cursor?: string | null;
  limit?: number | null;
}

export interface AgentEventPage {
  items: AgentEventHeaderV1[];
  nextCursor?: string | null;
  snapshotUpperBound: number;
}

export interface AgentEventPayload {
  eventId: string;
  contentType: string;
  body: string;
  byteLength: number;
  sha256: string;
}

export type AgentEventDeleteScope = AgentEventQueryScope;

export interface AgentEventDeleteResult {
  deletedHeaders: number;
  deletedPayloads: number;
  freedPayloadBytes: number;
  countsAccurate: boolean;
}

export interface AgentEventStoreStatus {
  capability: "enabled" | "disabled" | "corrupt" | "migrationRequired" | "unavailable";
  schemaVersion: 1;
  dataLocation: string;
  eventCount?: number | null;
  payloadBytes?: number | null;
  recoveredPartialTail: boolean;
  errorCode?: string | null;
  retention: { maxEvents: number; maxPayloadBytes: number; autoPrune: false };
  export: { supported: false; backgroundExport: false };
  privacy: {
    headerContainsPrivateBody: false;
    payloadRequiresExplicitRead: true;
    telemetryUpload: false;
  };
}

export function getAgentEventStoreStatus(): Promise<AgentEventStoreStatus> {
  return invoke("agent_event_store_status");
}

export function setAgentEventStoreEnabled(enabled: boolean): Promise<AgentEventStoreStatus> {
  return invoke("agent_event_store_set_enabled", { enabled });
}

export function appendAgentEvent(request: AgentEventAppendRequest): Promise<AgentEventAppendResult> {
  return invoke("agent_event_append", { request });
}

export function listAgentEvents(request: AgentEventListRequest): Promise<AgentEventPage> {
  return invoke("agent_event_list", { request });
}

export function listenForAgentEventHeaders(onHeader: (header: AgentEventHeaderV1) => void): Promise<UnlistenFn> {
  return listen<AgentEventHeaderV1>(AGENT_EVENT_APPENDED_EVENT, (event) => onHeader(event.payload));
}

export function readAgentEventPayload(eventId: string): Promise<AgentEventPayload> {
  return invoke("agent_event_payload", { eventId });
}

export function deleteAgentEvents(
  scope: AgentEventDeleteScope,
  confirmed: true,
): Promise<AgentEventDeleteResult> {
  return invoke("agent_event_delete", { request: { scope, confirmed } });
}
