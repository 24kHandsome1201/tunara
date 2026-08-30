import assert from "node:assert/strict";
import test from "node:test";

import {
  duplicateRemoteSessionFields,
  findShareableSshSession,
  sameSshEndpoint,
  sshEndpointIdentityFromRemote,
} from "../src/modules/ssh/connection-share.ts";
import { remoteExplorerFollowPath, terminalUploadDestination } from "../src/modules/ssh/remote-cwd.ts";
import { formatTransferEta, formatTransferRate, pushRateSample, transferEta, transferRate } from "../src/modules/ssh/transfer-rate.ts";
import { canResumeRecovery } from "../src/modules/ssh/transfer-resume.ts";

test("same SSH endpoint ignores host case and compares jump hops", () => {
  const a = sshEndpointIdentityFromRemote({
    host: "Herd.example",
    port: 22,
    user: "ubuntu",
    route: { jump: { host: "jump", port: 22, user: "jumpuser" } },
  });
  const b = {
    host: "herd.example",
    port: 22,
    user: "ubuntu",
    jump: { host: "JUMP", port: 22, user: "jumpuser" },
  };
  assert.equal(sameSshEndpoint(a, b), true);
  assert.equal(sameSshEndpoint(a, { ...b, jump: undefined }), false);
});

test("shareable SSH session is a live ready sibling, not the source itself", () => {
  const live = {
    id: "s-live",
    dir: "/home/ubuntu",
    remote: { host: "herd", port: 22, user: "ubuntu" },
    ptyId: 3,
    transportGeneration: "tg-1",
    runState: "idle",
    connection: { phase: "ready" },
  };
  const connecting = { ...live, id: "s-wait", ptyId: undefined, connection: { phase: "connecting" } };
  assert.equal(findShareableSshSession([connecting, live], { host: "herd", port: 22, user: "ubuntu" }, "s-new")?.id, "s-live");
  assert.equal(findShareableSshSession([live], { host: "herd", port: 22, user: "ubuntu" }, "s-live"), null);
  assert.deepEqual(duplicateRemoteSessionFields(live)?.remote.host, "herd");
});

test("follow-cwd only uses an absolute remote path", () => {
  assert.equal(remoteExplorerFollowPath({ remote: {}, dir: "ubuntu@herd" }), null);
  assert.equal(remoteExplorerFollowPath({ remote: {}, dir: "/home/ubuntu/app" }), "/home/ubuntu/app");
  assert.equal(terminalUploadDestination("/home/ubuntu", "notes.txt"), "/home/ubuntu/notes.txt");
  assert.equal(terminalUploadDestination("ubuntu@herd", "notes.txt"), null);
  assert.equal(terminalUploadDestination("/home/ubuntu", "../x"), null);
});

test("transfer rate and ETA format from a moving window", () => {
  const samples = pushRateSample([], { at: 1_000, bytes: 0 });
  const next = pushRateSample(samples, { at: 2_000, bytes: 1024 * 1024 });
  const rate = transferRate(next, 2_000);
  assert.ok(rate);
  assert.ok(rate.bytesPerSec > 0);
  assert.equal(formatTransferRate(1024), "1.0 KiB/s");
  assert.equal(formatTransferEta(transferEta(512, 1024, 256)), "2s");
  assert.equal(formatTransferEta(90), "1m 30s");
});

test("recovery resume requires verified partial bytes", () => {
  assert.equal(canResumeRecovery({ bytes: 0, commitIntent: false, partial: { path: "/tmp/a.partial" } }), false);
  assert.equal(canResumeRecovery({ bytes: 12, commitIntent: true, partial: { path: "/tmp/a.partial" } }), false);
  assert.equal(canResumeRecovery({ bytes: 12, commitIntent: false, partial: { path: "/tmp/a.partial" } }), true);
});
