import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("agent event store is registered only for the trusted main window", () => {
  const lib = read("src-tauri/src/lib.rs");
  const mainPermission = read("src-tauri/permissions/main.toml");
  const previewPermission = read("src-tauri/permissions/preview.toml");
  const generatedAcl = read("src-tauri/gen/schemas/acl-manifests.json");
  const commands = [
    "agent_event_store_status",
    "agent_event_store_set_enabled",
    "agent_event_append",
    "agent_event_list",
    "agent_event_payload",
    "agent_event_delete",
  ];
  for (const command of commands) {
    assert.match(lib, new RegExp(`agent_event_store::${command}`));
    assert.match(mainPermission, new RegExp(`"${command}"`));
    assert.match(generatedAcl, new RegExp(`"${command}"`));
    assert.doesNotMatch(previewPermission, new RegExp(command));
  }
  assert.match(lib, /manage\(pty::PtyState::default\(\)\)/);
  assert.match(lib, /AgentEventStoreState::from_app/);
  assert.match(lib, /Corrupt\/disabled data must never make[\s\S]*ordinary terminals fail/);
});

test("typed bridge keeps headers lightweight and payload reads explicit", () => {
  const bridge = read("src/modules/agent-events/agent-event-bridge.ts");
  const header = bridge.match(/export interface AgentEventHeaderV1 \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.match(header, /sequence: number/);
  assert.match(header, /clientEventId: string/);
  assert.match(header, /payload\?: AgentEventPayloadMetaV1/);
  assert.doesNotMatch(header, /body:|content:|prompt:|output:/);
  assert.match(bridge, /readAgentEventPayload\(eventId: string\)/);
  assert.match(bridge, /invoke\("agent_event_payload", \{ eventId \}\)/);
  assert.match(bridge, /privatePayload\?: AgentEventPrivatePayloadInput/);
  assert.match(bridge, /confirmed: true/);
});

test("M3 Event Store bridge stays framework-free and exposes bounded live headers", () => {
  const bridge = read("src/modules/agent-events/agent-event-bridge.ts");
  assert.doesNotMatch(bridge, /react|zustand/i);
  assert.equal(bridge.includes("AGENT_EVENT_MAX_PAGE_SIZE = 200"), true);
  assert.match(bridge, /agent-event:\/\/appended/);
  assert.match(bridge, /isAgentTimelineFeatureEnabled/);
  assert.match(bridge, /export: \{ supported: false; backgroundExport: false \}/);
  assert.match(bridge, /headerContainsPrivateBody: false/);
  assert.match(bridge, /payloadRequiresExplicitRead: true/);
  assert.match(bridge, /telemetryUpload: false/);
});
