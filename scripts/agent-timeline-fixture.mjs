#!/usr/bin/env node
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
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
const payloadCounts = { markdownCodeBlocks: 0, toolCalls: 0, diffs: 0, images: 0 };
const payloadStart = taskBoundary - 1_800;
const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function richPayload(index, sequence) {
  const richIndex = index - payloadStart;
  if (richIndex < 0 || richIndex >= 1_800) return null;
  if (richIndex < 1_000) {
    payloadCounts.markdownCodeBlocks += 1;
    const code = richIndex === 999
      ? Array.from({ length: 2_500 }, (_, line) => `const timelineLine${line} = ${line};`).join("\n")
      : `const timelineFixture${sequence} = ${sequence};`;
    return { contentType: "text/markdown", body: `## Markdown evidence ${sequence}\n\n\`\`\`ts\n${code}\n\`\`\`` };
  }
  if (richIndex < 1_500) {
    payloadCounts.toolCalls += 1;
    const body = richIndex === 1_499
      ? Array.from({ length: 5_000 }, (_, line) => `tool output ${line} 中文`).join("\n")
      : JSON.stringify({ tool: "fixture", sequence, passed: true });
    return { contentType: richIndex === 1_499 ? "text/plain" : "application/json", body };
  }
  if (richIndex < 1_700) {
    payloadCounts.diffs += 1;
    const body = richIndex === 1_699
      ? ["@@ -1,2500 +1,2500 @@", ...Array.from({ length: 2_500 }, (_, line) => line % 2 === 0 ? `-old line ${line}` : `+new line ${line}`)].join("\n")
      : `@@ -1 +1 @@\n-old ${sequence}\n+new ${sequence}`;
    return { contentType: "text/x-diff", body };
  }
  payloadCounts.images += 1;
  return { contentType: "image/png", body: png1x1 };
}

for (let index = 0; index < total; index += 1) {
  const sequence = index + 1;
  const taskId = index < taskBoundary ? "m3-timeline-a" : "m3-timeline-b";
  const localeSummary = index % 3 === 0
    ? `构建阶段 ${sequence}，验证 worktree 来源与长任务摘要不会遮挡终端`
    : `Build transition ${sequence}, source-bound worktree verification remains compact`;
  const privatePayload = richPayload(index, sequence);
  const payload = privatePayload ? {
    state: "available",
    contentType: privatePayload.contentType,
    byteLength: Buffer.byteLength(privatePayload.body),
    sha256: createHash("sha256").update(privatePayload.body).digest("hex"),
  } : null;
  const eventId = `ae-${String(sequence).padStart(20, "0")}`;
  lines.push(JSON.stringify({
    schemaVersion: 1,
    sequence,
    eventId,
    clientEventId: `fixture-${sequence}`,
    workspaceId,
    taskId,
    sessionId: taskId,
    kind: privatePayload?.contentType === "text/x-diff" ? "file_change" : privatePayload?.contentType.startsWith("image/") ? "preview_evidence" : privatePayload ? "tool_call" : kinds[index % kinds.length],
    source: privatePayload ? "hook" : sources[index % sources.length],
    occurredAtMs: occurredBase + sequence * 17,
    recordedAtMs: occurredBase + sequence * 17,
    summary: localeSummary,
    payload,
  }));
  if (privatePayload) {
    await writeFile(path.join(root, "payloads", `${eventId}.json`), JSON.stringify({ schemaVersion: 1, eventId, contentType: privatePayload.contentType, body: privatePayload.body }), { mode: 0o600 });
  }
}
await writeFile(path.join(root, "manifest.json"), JSON.stringify({ schemaVersion: 1, deleteGeneration: 0 }), { mode: 0o600 });
await writeFile(path.join(root, "headers.jsonl"), `${lines.join("\n")}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ total, workspaceId, tasks: { "m3-timeline-a": taskBoundary, "m3-timeline-b": total - taskBoundary }, payloadCounts })}\n`);
