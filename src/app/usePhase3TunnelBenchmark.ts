import { useEffect, useRef } from "react";
import { error as logError, info } from "@tauri-apps/plugin-log";
import { createSession, useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import type { PreviewSource } from "@/modules/preview/preview-source";
import {
  previewActionNonce,
  previewClose,
  previewOpen,
  previewRefresh,
  previewRemoteSourceObserved,
  previewStatus,
  previewTunnelClose,
  previewTunnelOpen,
  previewTunnelStatus,
  type PreviewTunnelState,
} from "@/modules/preview/preview-window";
import {
  TERMINAL_BENCHMARK_VARIANT,
  waitForTerminalBenchmarkWriters,
  writeTerminalBenchmark,
} from "@/modules/terminal/lib/terminal-benchmark";

const WAIT_MS = 60_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(label: string, read: () => T | null | undefined | false | Promise<T | null | undefined | false>): Promise<T> {
  const deadline = performance.now() + WAIT_MS;
  while (performance.now() < deadline) {
    const value = await read();
    if (value !== null && value !== undefined && value !== false) return value as T;
    await delay(100);
  }
  throw new Error(`Phase 3 SSH tunnel benchmark timed out waiting for ${label}`);
}

async function rejected(action: () => Promise<unknown>): Promise<boolean> {
  try {
    await action();
    return false;
  } catch {
    return true;
  }
}

async function sourceFor(sessionId: string, url: string): Promise<PreviewSource> {
  const source = await waitFor(`remote source ${url}`, () => {
    const session = useSessionsStore.getState().sessions.find((candidate) => candidate.id === sessionId);
    return session?.previewSources?.find((candidate) => candidate.sourceUrl === url
      && candidate.transport === "ssh"
      && candidate.permission === "remote-manual"
      && candidate.state === "active"
      && candidate.workspaceResolution === "resolved"
      && candidate.physicalPtyId !== undefined
      && candidate.sshHost
      && candidate.sshUser) ?? null;
  });
  await previewRemoteSourceObserved(source);
  return source;
}

async function runtimeReady(source: PreviewSource): Promise<boolean> {
  return waitFor(`Preview ready ${source.sourceUrl}`, async () => (await previewStatus(source))?.status === "ready");
}

async function telemetryComplete(source: PreviewSource, label: "A" | "B"): Promise<boolean> {
  try {
    return await waitFor(`Preview ACL ${label}`, async () => {
      const events = (await previewStatus(source))?.telemetry.events ?? [];
      const messages = events.map((event) => event.message);
      return messages.some((message) => message.includes(`TUNARA_TUNNEL_${label}_ACL_COMPLETE`)
        && message.includes("rejected=file,store,pty,ssh,tunnel,app")
        && message.includes("unexpected=none"));
    });
  } catch (error) {
    const messages = (await previewStatus(source))?.telemetry.events.map((event) => event.message) ?? [];
    const failure = new Error(`${String(error)}; telemetry=${JSON.stringify(messages)}`) as Error & { cause: unknown };
    failure.cause = error;
    throw failure;
  }
}

function fulfilledTunnel(results: PromiseSettledResult<PreviewTunnelState>[]): PreviewTunnelState {
  const fulfilled = results.filter((result): result is PromiseFulfilledResult<PreviewTunnelState> => result.status === "fulfilled");
  if (fulfilled.length !== 1) throw new Error(`expected one tunnel winner, got ${fulfilled.length}`);
  return fulfilled[0].value;
}

export function usePhase3TunnelBenchmark(ready: boolean): void {
  const started = useRef(false);
  useEffect(() => {
    if (TERMINAL_BENCHMARK_VARIANT !== "phase3-tunnel" || !ready || started.current) return;
    started.current = true;
    let cancelled = false;
    void (async () => {
      const host = import.meta.env.VITE_TUNARA_PHASE3_SSH_HOST as string | undefined;
      const user = import.meta.env.VITE_TUNARA_PHASE3_SSH_USER as string | undefined;
      const identityFile = import.meta.env.VITE_TUNARA_PHASE3_SSH_IDENTITY as string | undefined;
      const rootA = import.meta.env.VITE_TUNARA_PHASE3_SSH_ROOT_A as string | undefined;
      const rootB = import.meta.env.VITE_TUNARA_PHASE3_SSH_ROOT_B as string | undefined;
      const fixture = import.meta.env.VITE_TUNARA_PHASE3_SSH_FIXTURE as string | undefined;
      const sshPort = Number(import.meta.env.VITE_TUNARA_PHASE3_SSH_PORT);
      const remotePort = Number(import.meta.env.VITE_TUNARA_PHASE3_REMOTE_PORT);
      if (!host || !user || !identityFile || !rootA || !rootB || !fixture
        || !Number.isInteger(sshPort) || !Number.isInteger(remotePort)) {
        throw new Error("Phase 3 tunnel benchmark build is missing SSH configuration");
      }
      const remote = { host, user, port: sshPort, identityFile, injectShellIntegration: true };
      const sessionA = createSession(rootA, { title: "Phase 3 SSH tunnel A", remote });
      const sessionB = createSession(rootB, { title: "Phase 3 SSH tunnel B", remote });
      useSessionsStore.setState({ sessions: [], activeSessionId: null, launchedSessionIds: {} });
      useUIStore.setState({ panelVisible: true, inspectorTab: "preview", overlay: null, split: { root: null } });
      await delay(0);
      useSessionsStore.getState().addSession(sessionA);
      useSessionsStore.getState().addSession(sessionB);
      useSessionsStore.getState().setActive(sessionA.id);
      const writers = await waitForTerminalBenchmarkWriters([sessionA.id, sessionB.id]);
      if (writers.length !== 2) throw new Error(`mounted ${writers.length}/2 SSH PTYs`);
      await waitFor("two resolved SSH workspaces", () => {
        const sessions = useSessionsStore.getState().sessions.filter((session) => session.id === sessionA.id || session.id === sessionB.id);
        return sessions.length === 2 && sessions.every((session) => session.workspace && session.ptyId !== undefined) ? true : null;
      });

      const urlA = `http://127.0.0.1:${remotePort}/`;
      const urlB = `http://[::1]:${remotePort}/`;
      await Promise.all([
        writeTerminalBenchmark(sessionA.id, `python3 ${fixture} --host 127.0.0.1 --port ${remotePort} --label A\n`),
        writeTerminalBenchmark(sessionB.id, `python3 ${fixture} --host ::1 --port ${remotePort} --label B\n`),
      ]);
      const [sourceA, sourceB] = await Promise.all([sourceFor(sessionA.id, urlA), sourceFor(sessionB.id, urlB)]);

      const nonceA = previewActionNonce();
      const raceA = await Promise.allSettled([
        previewTunnelOpen(sourceA, nonceA),
        previewTunnelOpen(sourceA, previewActionNonce()),
      ]);
      const tunnelA = fulfilledTunnel(raceA);
      const concurrentOpenRejected = raceA.filter((result) => result.status === "rejected").length === 1;
      const nonceReplayRejected = await rejected(() => previewTunnelOpen(sourceA, nonceA));
      if (!tunnelA.previewSource || !tunnelA.localEndpoint) throw new Error("tunnel A missing derived endpoint");
      await previewOpen(tunnelA.previewSource);

      const tunnelB = await previewTunnelOpen(sourceB, previewActionNonce());
      if (!tunnelB.previewSource || !tunnelB.localEndpoint) throw new Error("tunnel B missing derived endpoint");
      await previewOpen(tunnelB.previewSource);
      await Promise.all([runtimeReady(tunnelA.previewSource), runtimeReady(tunnelB.previewSource)]);
      await Promise.all([telemetryComplete(tunnelA.previewSource, "A"), telemetryComplete(tunnelB.previewSource, "B")]);

      const endpointsDistinct = tunnelA.localEndpoint !== tunnelB.localEndpoint;
      const sourcesDistinct = sourceA.workspaceId !== sourceB.workspaceId
        && sourceA.worktreeId !== sourceB.worktreeId
        && sourceA.physicalPtyId !== sourceB.physicalPtyId;
      const remotePortSame = tunnelA.remotePort === tunnelB.remotePort && tunnelA.remotePort === remotePort;
      const bothEndpointsReachable = (await previewTunnelStatus(sourceA))?.status === "ready"
        && (await previewTunnelStatus(sourceB))?.status === "ready";
      const aclUnexpectedSuccesses = ((await previewStatus(tunnelA.previewSource))?.telemetry.text ?? "")
        .includes("ACL_UNEXPECTED_SUCCESS_")
        || ((await previewStatus(tunnelB.previewSource))?.telemetry.text ?? "").includes("ACL_UNEXPECTED_SUCCESS_");
      const crossWorktreeRejected = await rejected(() => previewTunnelOpen({ ...sourceA, worktreeId: sourceB.worktreeId }, previewActionNonce()));
      const staleRejected = await rejected(() => previewTunnelOpen({ ...sourceA, state: "stale" }, previewActionNonce()));
      const oldGenerationRejected = await rejected(() => previewTunnelOpen({ ...sourceA, physicalPtyId: sourceA.physicalPtyId! + 100_000 }, previewActionNonce()));

      await writeTerminalBenchmark(sessionA.id, "\u0003");
      await delay(500);
      await previewRefresh(tunnelA.previewSource);
      const failedA = await waitFor("A tunnel failed", async () => (await previewTunnelStatus(sourceA))?.status === "failed");
      const readyBWhileAFailed = (await previewTunnelStatus(sourceB))?.status === "ready"
        && (await previewStatus(tunnelB.previewSource))?.status === "ready";

      await previewClose(tunnelB.previewSource);
      const closedB = await waitFor("B explicit close", async () => (await previewTunnelStatus(sourceB)) === null);
      const tunnelB2 = await previewTunnelOpen(sourceB, previewActionNonce());
      if (!tunnelB2.previewSource || !tunnelB2.localEndpoint) throw new Error("tunnel B reopen missing endpoint");
      await previewOpen(tunnelB2.previewSource);
      await runtimeReady(tunnelB2.previewSource);
      const explicitReopenReady = (await previewTunnelStatus(sourceB))?.status === "ready";
      await writeTerminalBenchmark(sessionB.id, "\u0003exit\n");
      const terminalExited = await waitFor("SSH terminal exit", () => {
        const session = useSessionsStore.getState().sessions.find((candidate) => candidate.id === sessionB.id);
        return session && session.ptyId === undefined ? true : null;
      });
      const exitListenerClosed = await waitFor("B listener cleanup after SSH exit", async () => (await previewTunnelStatus(sourceB)) === null);
      const exitSourceRejected = await rejected(() => previewTunnelOpen(sourceB, previewActionNonce()));

      await previewTunnelClose(sourceA).catch(() => {});
      await writeTerminalBenchmark(sessionA.id, "exit\n").catch(() => {});
      if (cancelled) return;
      const report = {
        benchmark: "phase3-preview-ssh-tunnel",
        twoResolvedWorktrees: sourcesDistinct,
        twoPhysicalPtys: sourceA.physicalPtyId !== sourceB.physicalPtyId,
        sameRemotePort: remotePortSame,
        distinctLocalEndpoints: endpointsDistinct,
        bothEndpointsReachable,
        aclUnexpectedSuccesses: aclUnexpectedSuccesses ? 1 : 0,
        concurrentOpenRejected,
        nonceReplayRejected,
        crossWorktreeRejected,
        staleRejected,
        oldGenerationRejected,
        remoteStopFailedOnlyA: Boolean(failedA && readyBWhileAFailed),
        explicitCloseRemovedListener: Boolean(closedB),
        explicitReopenReady,
        terminalExited: Boolean(terminalExited),
        exitListenerClosed: Boolean(exitListenerClosed),
        exitSourceRejected,
      };
      const passed = Object.entries(report).every(([key, value]) => {
        if (key === "benchmark") return true;
        if (key === "aclUnexpectedSuccesses") return value === 0;
        return value === true;
      });
      await info(`[benchmark:phase3-tunnel] ${JSON.stringify({ ...report, passed })}`);
    })().catch(async (reason) => {
      await logError(`[benchmark:phase3-tunnel] ${JSON.stringify({ benchmark: "phase3-preview-ssh-tunnel", passed: false, error: String(reason) })}`);
    });
    return () => { cancelled = true; };
  }, [ready]);
}
