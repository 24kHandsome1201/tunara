import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const fixture = path.resolve("scripts/fixtures/pi-loopback-provider.py");

async function waitForFile(file, child, stderr) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return (await readFile(file, "utf8")).trim();
    } catch {
      if (child.exitCode !== null) {
        throw new Error(`provider exited ${child.exitCode}: ${stderr()}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`timed out waiting for ${file}`);
}

async function withProvider(t, run) {
  const root = await mkdtemp(path.join(tmpdir(), "tunara-pi-provider-test-"));
  const state = path.join(root, "state.json");
  const port = path.join(root, "port");
  const token = "test-only-bearer-token";
  const child = spawn("python3", [fixture, state, port, token], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    let portNumber;
    try {
      portNumber = await waitForFile(port, child, () => stderr);
    } catch (error) {
      if (stderr.includes("Operation not permitted") || stderr.includes("PermissionError")) {
        t.skip("local sandbox does not permit loopback socket binding");
        return;
      }
      throw error;
    }
    const endpoint = `http://127.0.0.1:${portNumber}/v1/chat/completions`;
    await run({ endpoint, state, token });
  } finally {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 1000))]);
    await rm(root, { recursive: true, force: true });
  }
}

function request(endpoint, token, messages) {
  return fetch(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: "probe", stream: true, messages }),
  });
}

test("Pi loopback provider rejects unauthenticated requests", async (t) => {
  await withProvider(t, async ({ endpoint, state }) => {
    const response = await request(endpoint, "wrong-token", []);
    assert.equal(response.status, 401);
    const evidence = JSON.parse(await readFile(state, "utf8"));
    assert.equal(evidence.allRequestsAuthenticated, false);
    assert.equal(evidence.authorizationFailures, 1);
  });
});

test("Pi loopback provider requires restored user and assistant context", async (t) => {
  await withProvider(t, async ({ endpoint, state, token }) => {
    const first = await request(endpoint, token, [
      { role: "user", content: "Remember TUNARA_PI_CONTEXT_7412" },
    ]);
    assert.equal(first.status, 200);
    assert.match(await first.text(), /TUNARA_PI_FIRST_OK/);

    const resume = await request(endpoint, token, [
      { role: "user", content: "Remember TUNARA_PI_CONTEXT_7412" },
      { role: "assistant", content: "TUNARA_PI_FIRST_OK" },
      { role: "user", content: "TUNARA_PI_RESUME_REQUEST_8524" },
    ]);
    assert.equal(resume.status, 200);
    assert.match(await resume.text(), /TUNARA_PI_RESUME_OK/);

    const evidence = JSON.parse(await readFile(state, "utf8"));
    assert.equal(evidence.mainRequestCount, 2);
    assert.equal(evidence.resumeContextSeen, true);
    assert.equal(evidence.firstAssistantMarkerReplayed, true);
    assert.equal(evidence.allRequestsAuthenticated, true);
  });
});

test("Pi loopback provider rejects resume without assistant replay", async (t) => {
  await withProvider(t, async ({ endpoint, token }) => {
    const response = await request(endpoint, token, [
      { role: "user", content: "TUNARA_PI_CONTEXT_7412 TUNARA_PI_RESUME_REQUEST_8524" },
    ]);
    assert.equal(response.status, 409);
  });
});
