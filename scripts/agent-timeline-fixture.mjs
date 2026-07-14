#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const [outputRoot, repositoryIdentity, totalRaw = "10000"] = process.argv.slice(2);
const total = Number(totalRaw);
if (!outputRoot || !repositoryIdentity || !Number.isSafeInteger(total) || total < 1 || total > 100_000) {
  throw new Error("usage: agent-timeline-fixture.mjs <agent-events-dir> <repository-identity> [count]");
}

const root = path.join(outputRoot, "v1");
await mkdir(path.join(root, "payloads"), { recursive: true, mode: 0o700 });
const workspaceId = `ws-${createHash("sha256").update(repositoryIdentity).digest("hex")}`;
const taskBoundary = Math.floor(total * 0.9);
const occurredBase = 1_720_000_000_000;
const kinds = ["agent_status", "output_summary", "tool_call", "file_change", "test_result", "confirmation_request", "preview_evidence"];
const sources = ["hook", "process", "shell_integration", "system", "heuristic"];
const lines = [];
for (let index = 0; index < total; index += 1) {
  const sequence = index + 1;
  const taskId = index < taskBoundary ? "m3-timeline-a" : "m3-timeline-b";
  const localeSummary = index % 3 === 0
    ? `构建阶段 ${sequence}，验证 worktree 来源与长任务摘要不会遮挡终端`
    : `Build transition ${sequence}, source-bound worktree verification remains compact`;
  lines.push(JSON.stringify({
    schemaVersion: 1,
    sequence,
    eventId: `ae-${String(sequence).padStart(20, "0")}`,
    clientEventId: `fixture-${sequence}`,
    workspaceId,
    taskId,
    sessionId: taskId,
    kind: kinds[index % kinds.length],
    source: sources[index % sources.length],
    occurredAtMs: occurredBase + sequence * 17,
    recordedAtMs: occurredBase + sequence * 17,
    summary: localeSummary,
    payload: null,
  }));
}
await writeFile(path.join(root, "manifest.json"), JSON.stringify({ schemaVersion: 1, deleteGeneration: 0 }), { mode: 0o600 });
await writeFile(path.join(root, "headers.jsonl"), `${lines.join("\n")}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ total, workspaceId, tasks: { "m3-timeline-a": taskBoundary, "m3-timeline-b": total - taskBoundary } })}\n`);
