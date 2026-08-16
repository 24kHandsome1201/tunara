import { invoke, Channel } from "@tauri-apps/api/core";
import { useUIStore } from "@/state/ui";
import { useSessionsStore } from "@/state/sessions";
import { t } from "@/modules/i18n";
import type { RemoteInfo } from "@/ui/types";
import { classifySshFailure } from "@/modules/ssh/failure-reason";
import type { SshAuthMethod } from "@/modules/ssh/hosts-model";
import type { PendingSshCredentials } from "@/modules/ssh/pending-credentials";
import { appendDiagnostic, recordSshLifecycleDiagnostic } from "@/modules/ssh/diagnostics-store";
import { SSH_DIAGNOSTIC_CODES, SSH_DIAGNOSTIC_STAGES, type SshDiagnosticV1 } from "@/modules/ssh/diagnostics-schema";
import type { BackendConnectionPhase } from "./connection-state";
import { recordTerminalBenchmarkExit, TERMINAL_BENCHMARK_MODE } from "./terminal-benchmark";
import { localUsageAuthMethod, localUsageDuration, localUsageErrorCategory, recordLocalUsageEvent } from "@/modules/usage-log/local-usage-log";

export type PtyEvent =
  | { type: "data"; data: string }
  | { type: "transportLost"; reason: string }
  | { type: "exit"; code: number }
  | { type: "connectionStatus"; phase: BackendConnectionPhase }
  | {
      type: "hostKeyPrompt";
      promptId: string;
      host: string;
      port: number;
      fingerprint: string;
      keyType: string;
      /** "unknown" = first contact (accepting persists); "unverifiable" = key
       *  couldn't be confirmed against a relevant known_hosts record (not persisted). */
      reason: string;
    }
  | { type: "hostKeyPersistence"; host: string; port: number; status: "saved" | "sessionOnly" | "preCommitFailure" | "committedButDurabilityUnknown" }
  | {
      type: "keyboardInteractivePrompt";
      promptId: string;
      origin: {
        user: string; host: string; port: number; logicalSessionId: string;
        hopRole: "direct" | "jump" | "target"; transportGeneration: string;
      };
      name: string;
      instructions: string;
      prompts: Array<{ prompt: string; echo: boolean }>;
    };

function notifyHostKeyPersistence(
  event: Extract<PtyEvent, { type: "hostKeyPersistence" }>,
  sessionId?: string,
): void {
  const outcome = event.status === "saved" ? "saved"
    : event.status === "sessionOnly" || event.status === "preCommitFailure" ? "session_only"
      : "durability_unknown";
  recordLocalUsageEvent({
    event: "ssh.host_key.persistence",
    sessionId,
    success: event.status === "saved",
    outcome,
  });
  const host = event.port === 22 ? event.host : `${event.host}:${event.port}`;
  useUIStore.getState().addToast({
    title: t(`ssh.hostKey.persistence.${event.status}`),
    subtitle: host,
    variant: event.status === "saved" ? "success" : "warning",
    durationMs: event.status === "saved" ? 3500 : 8000,
  });
}

/** Backend sentinel for an SSH transport that ended without ExitStatus. */
export const SSH_DISCONNECTED_EXIT_CODE = -2;

/** Reply to a pending SSH host-key prompt (backend ssh_open is parked on it). */
export async function answerHostKeyPrompt(promptId: string, accept: boolean, remember = true): Promise<void> {
  const startedAt = Date.now();
  try {
    await invoke("ssh_host_key_decision", { promptId, accept, remember });
    recordLocalUsageEvent({
      event: "ssh.host_key.decided",
      correlationId: promptId,
      durationMs: localUsageDuration(startedAt),
      success: true,
      outcome: accept ? "accepted" : "rejected",
    });
  } catch (error) {
    recordLocalUsageEvent({
      event: "ssh.host_key.decided",
      correlationId: promptId,
      durationMs: localUsageDuration(startedAt),
      success: false,
      outcome: "failed",
      errorCategory: localUsageErrorCategory(error),
    });
    throw error;
  }
}

export async function answerKeyboardInteractivePrompt(
  promptId: string,
  responses: string[] | null,
): Promise<void> {
  await invoke("ssh_keyboard_interactive_response", { promptId, responses });
}

const sshOpenAttempts = new Map<string, string>();
const cancelledSshOpenAttempts = new Set<string>();
// Unlike sshOpenAttempts (which exists only while invoke("ssh_open") is
// pending), this map stays alive for the physical connection's lifetime. It
// prevents a superseded Channel from delivering late phases, prompts, output,
// or exit events into a newer render generation of the same logical session.
const sshConnectionGenerations = new Map<string, string>();
let sshOpenAttemptCounter = 0;

function nextSshOpenAttemptId(): string {
  return globalThis.crypto?.randomUUID?.()
    ?? `ssh-${Date.now()}-${sshOpenAttemptCounter += 1}`;
}

function nextPtyGeneration(transport: "local" | "ssh"): string {
  return `${transport}:${nextSshOpenAttemptId()}`;
}

/** Cancel an SSH open before it has returned a physical PTY id. */
export async function cancelSshOpen(logicalSessionId: string): Promise<void> {
  const openAttemptId = sshOpenAttempts.get(logicalSessionId);
  if (!openAttemptId || cancelledSshOpenAttempts.has(openAttemptId)) return;
  cancelledSshOpenAttempts.add(openAttemptId);
  try {
    await invoke("ssh_cancel_open", { openAttemptId });
  } catch {
    /* attempt may already have completed or failed */
  }
}

/** Map a raw ssh_open error into a short, localized failure reason. */
export function sshFailureReason(error: string): string {
  return t(`ssh.fail.${classifySshFailure(error)}`);
}

/** Typed v2 errors are consumed directly; legacy strings are classified once and discarded. */
export function safeSshFailure(error: unknown): { reason: ReturnType<typeof classifySshFailure>; message: string } {
  const code = typeof error === "object" && error !== null && "diagnostic" in error
    ? String((error as { diagnostic?: { code?: unknown } }).diagnostic?.code ?? "internal")
    : undefined;
  const reason = code === "authenticationFailed" ? "auth"
    : code === "hostKeyRejected" ? "hostKey"
      : code === "dnsFailed" || code === "connectionRefused" || code === "timeout" || code === "transportClosed" ? "connect"
        : classifySshFailure(typeof error === "string" ? error : "");
  return { reason, message: t(`ssh.fail.${reason}`) };
}

function typedSshDiagnostic(error: unknown): SshDiagnosticV1 | undefined {
  if (typeof error !== "object" || error === null || !("diagnostic" in error)) return undefined;
  const diagnostic = (error as { diagnostic?: Partial<SshDiagnosticV1> }).diagnostic;
  if (diagnostic?.schemaVersion !== 1
    || !SSH_DIAGNOSTIC_STAGES.includes(diagnostic.stage as SshDiagnosticV1["stage"])
    || !SSH_DIAGNOSTIC_CODES.includes(diagnostic.code as SshDiagnosticV1["code"])
    || !["info", "warning", "error"].includes(diagnostic.severity ?? "")
    || typeof diagnostic.retryable !== "boolean"
    || !["direct", "jump", "target"].includes(diagnostic.hopRole ?? "")
    || typeof diagnostic.timestamp !== "number") return undefined;
  return diagnostic as SshDiagnosticV1;
}

export function sshOpenDiagnostic(error: unknown): SshDiagnosticV1 | undefined {
  return typedSshDiagnostic(error);
}

/**
 * Surface a failed SSH connection consistently: mark the session failed and
 * raise an error Toast (matching the rest of the app's error handling). No-op
 * for local sessions, which already show the inline red error line.
 */
export function reportSshOpenFailure(
  sessionId: string,
  remote: RemoteInfo | undefined,
  error: unknown,
): void {
  if (!remote) return;
  const { reason } = safeSshFailure(error);
  const store = useSessionsStore.getState();
  const typed = typedSshDiagnostic(error);
  const phase = store.sessions.find((session) => session.id === sessionId)?.connection?.phase;
  const authFailure = ["password", "key", "agent", "keyboardInteractive", "auth"].includes(reason);
  const stage = phase === "authenticating" || authFailure ? "auth"
    : phase === "handshaking" ? "handshake"
      : reason === "hostKey" ? "hostKey" : "TCP";
  const code = authFailure ? "authenticationFailed"
    : reason === "hostKey" ? "hostKeyRejected" : "transportClosed";
  if (typed) {
    appendDiagnostic(sessionId, { requestId: "ssh-open-v2", status: "failed", diagnostic: typed });
  } else {
    recordSshLifecycleDiagnostic(sessionId, stage, "failed", code);
  }
  store.updateSession(sessionId, { runState: "failed" });
  store.handleConnectionEvent(sessionId, {
    type: "failed",
    transport: "ssh",
    reason,
    detail: reason,
  });
  notifySshOpenFailure(sessionId, remote, error);
}

/** Show a failed replacement attempt without marking a still-live PTY failed. */
export function notifySshOpenFailure(
  sessionId: string,
  _remote: RemoteInfo,
  error: unknown,
): void {
  useUIStore.getState().addToast({
    sessionId,
    title: t("ssh.error.title"),
    subtitle: safeSshFailure(error).message,
    variant: "error",
  });
}

export type PtyHandlers = {
  onData: (bytes: Uint8Array, acknowledge: () => void, generation: string) => void;
  onTransportLost?: (reason: string, generation: string) => void;
  onExit?: (code: number, generation: string) => void;
  onConnectionStatus?: (phase: PtyConnectionStatusPhase, generation: string) => void;
  /** Candidate-only progress; the bridge admits it only for the latest open attempt. */
  onPendingConnectionStatus?: (phase: PtyConnectionStatusPhase) => void;
};

export type PtyConnectionStatusPhase = BackendConnectionPhase | "verifyingHostKey";

function acceptsTransportGeneration(sessionId: string, generation: string): boolean {
  const current = useSessionsStore.getState().sessions.find((session) => session.id === sessionId);
  return current?.transportGeneration === generation;
}

export function recordPtyConnectionStatus(
  sessionId: string,
  phase: PtyConnectionStatusPhase,
  generation: string,
): void {
  if (!acceptsTransportGeneration(sessionId, generation)) return;
  recordConnectionStage(sessionId, phase);
  useSessionsStore.getState().handleConnectionEvent(
    sessionId,
    phase === "verifyingHostKey"
      ? { type: "hostKeyPrompt" }
      : { type: "backendPhase", transport: "ssh", phase },
  );
}

/** Record progress already proven by openSshPty to belong to the latest candidate. */
export function recordPendingPtyConnectionStatus(
  sessionId: string,
  phase: PtyConnectionStatusPhase,
): void {
  useSessionsStore.getState().handleConnectionEvent(
    sessionId,
    phase === "verifyingHostKey"
      ? { type: "hostKeyPrompt" }
      : { type: "backendPhase", transport: "ssh", phase },
  );
}

function recordConnectionStage(sessionId: string, phase: PtyConnectionStatusPhase): void {
  const session = useSessionsStore.getState().sessions.find((candidate) => candidate.id === sessionId);
  const binding = session?.ptyId !== undefined && session.transportGeneration
    ? {
        logicalSessionId: sessionId,
        physicalPtyId: session.ptyId,
        transportGeneration: session.transportGeneration,
      }
    : undefined;
  if (phase === "handshaking") {
    recordSshLifecycleDiagnostic(sessionId, "TCP", "passed", "ok", binding);
  } else if (phase === "authenticating") {
    recordSshLifecycleDiagnostic(sessionId, "handshake", "passed", "ok", binding);
    recordSshLifecycleDiagnostic(sessionId, "hostKey", "passed", "ok", binding);
  } else if (phase === "openingShell") {
    recordSshLifecycleDiagnostic(sessionId, "auth", "passed", "ok", binding);
  } else if (phase === "ready") {
    recordSshLifecycleDiagnostic(sessionId, "openShell", "passed", "ok", binding);
  }
}

export function recordPtyExit(sessionId: string, remote: boolean, code: number, generation: string): void {
  if (!acceptsTransportGeneration(sessionId, generation)) return;
  if (TERMINAL_BENCHMARK_MODE) recordTerminalBenchmarkExit(sessionId, code);
  if (remote && code === SSH_DISCONNECTED_EXIT_CODE) {
    recordSshLifecycleDiagnostic(
      sessionId,
      "reconnect",
      "failed",
      "transportClosed",
    );
  }
  useSessionsStore.getState().handleConnectionEvent(sessionId, {
    type: "exit",
    transport: remote ? "ssh" : "local",
    code,
    disconnected: remote && code === SSH_DISCONNECTED_EXIT_CODE,
  });
}

export type PtySession = {
  id: number;
  generation: string;
  /** Publish queued events only after the renderer has installed this generation. */
  activate: () => boolean;
  write: (data: string) => Promise<void>;
  resize: (cols: number, rows: number) => Promise<void>;
  close: () => Promise<void>;
};

function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function createOutputAcknowledger() {
  let id: number | null = null;
  let pendingBytes = 0;
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    if (id === null || pendingBytes === 0) return;
    const bytes = pendingBytes;
    pendingBytes = 0;
    void invoke("pty_output_ack", { id, bytes }).catch((error) => {
      console.debug("[pty-bridge] output acknowledgement failed", error);
    });
  };
  const schedule = () => {
    if (scheduled || id === null || pendingBytes === 0) return;
    scheduled = true;
    void Promise.resolve().then(flush);
  };
  return {
    setId(value: number) {
      id = value;
      schedule();
    },
    acknowledge(bytes: number) {
      pendingBytes += bytes;
      schedule();
    },
  };
}

export async function openPty(
  logicalSessionId: string,
  cols: number,
  rows: number,
  handlers: PtyHandlers,
  cwd?: string,
): Promise<PtySession> {
  const generation = nextPtyGeneration("local");
  const acknowledger = createOutputAcknowledger();
  const channel = new Channel<PtyEvent>();
  let activated = false;
  let closed = false;
  let pendingEvents: PtyEvent[] = [];
  const dispatch = (event: PtyEvent) => {
    switch (event.type) {
      case "data": {
        const bytes = decodeBase64(event.data);
        let acknowledged = false;
        handlers.onData(bytes, () => {
          if (acknowledged) return;
          acknowledged = true;
          acknowledger.acknowledge(bytes.byteLength);
        }, generation);
        break;
      }
      case "transportLost":
        handlers.onTransportLost?.(event.reason, generation);
        break;
      case "exit":
        handlers.onExit?.(event.code, generation);
        break;
      case "connectionStatus":
        handlers.onConnectionStatus?.(event.phase, generation);
        break;
      case "hostKeyPersistence":
        notifyHostKeyPersistence(event);
        break;
      case "hostKeyPrompt":
      case "keyboardInteractivePrompt":
        break;
    }
  };
  channel.onmessage = (event) => {
    if (closed) return;
    if (activated) dispatch(event);
    else pendingEvents.push(event);
  };

  const id = await invoke<number>("pty_open", {
    logicalSessionId,
    cols,
    rows,
    cwd: cwd ?? null,
    onEvent: channel,
  });
  acknowledger.setId(id);

  return {
    id,
    generation,
    activate: () => {
      if (closed || activated) return false;
      activated = true;
      const queued = pendingEvents;
      pendingEvents = [];
      for (const event of queued) dispatch(event);
      return true;
    },
    write: (data) => invoke("pty_write", { id, data }),
    resize: (c, r) => invoke("pty_resize", { id, cols: c, rows: r }),
    close: () => {
      closed = true;
      pendingEvents = [];
      return invoke("pty_close", { id });
    },
  };
}

/** 远程会话连接信息（与 Session.remote / RemoteInfo 对齐）。 */
export type RemoteOpenInfo = {
  host: string;
  port: number;
  user: string;
  authMethod?: SshAuthMethod;
  identityFile?: string;
  certificateFile?: string;
  /** 加密私钥口令，仅本次连接，绝不持久化。 */
  keyPassphrase?: string;
  /** 密码认证，仅本次连接，绝不持久化。 */
  password?: string;
  jump?: SshConnectEndpointOptions;
  /** Phase 4：注入远程 shell 集成（远程 cwd / 命令边界 / agent 检测）。 */
  injectShellIntegration?: boolean;
};

/** Add one-shot secrets at the UI-to-bridge boundary without mutating persisted remote state. */
export function toRemoteOpenInfo(
  remote: RemoteInfo,
  credentials?: PendingSshCredentials,
): RemoteOpenInfo {
  return {
    ...remote,
    password: credentials?.password,
    keyPassphrase: credentials?.keyPassphrase,
    jump: remote.route ? {
      ...remote.route.jump,
      password: credentials?.jumpPassword,
      keyPassphrase: credentials?.jumpKeyPassphrase,
    } : undefined,
  };
}

/**
 * 按会话类型开 PTY：有 remote 走 SSH，否则走本地 shell。
 * 两者返回同一个 PtySession 接口，调用方（TerminalView）无需分支。
 */
export function openSessionPty(
  logicalSessionId: string,
  cols: number,
  rows: number,
  handlers: PtyHandlers,
  opts: { cwd?: string; remote?: RemoteOpenInfo; shareWithLogicalSessionId?: string },
): Promise<PtySession> {
  if (opts.remote) {
    return openSshPty(logicalSessionId, cols, rows, handlers, {
      host: opts.remote.host,
      port: opts.remote.port,
      user: opts.remote.user,
      authMethod: opts.remote.authMethod,
      cwd: opts.cwd?.startsWith("/") ? opts.cwd : undefined,
      identityFile: opts.remote.identityFile,
      certificateFile: opts.remote.certificateFile,
      keyPassphrase: opts.remote.keyPassphrase,
      password: opts.remote.password,
      injectShellIntegration: opts.remote.injectShellIntegration,
      jump: opts.remote.jump,
      shareWithLogicalSessionId: opts.shareWithLogicalSessionId,
    });
  }
  // A local reopen of the same logical session also supersedes any old SSH
  // Channel. The backend independently cancels a still-pending SSH publish.
  sshConnectionGenerations.delete(logicalSessionId);
  return openPty(logicalSessionId, cols, rows, handlers, opts.cwd);
}

/** One independently authenticated SSH endpoint. Secrets are one-shot only. */
export type SshConnectEndpointOptions = {
  host: string;
  port?: number;
  user: string;
  /** Explicit method. Missing survives only on legacy restores so the backend
   * can reject it clearly and route the user through the reconnect sheet. */
  authMethod?: SshAuthMethod;
  /** 恢复远程会话时的绝对 POSIX cwd；伪目录 user@host 不会传入。 */
  cwd?: string;
  /** 私钥文件路径；仅在显式选择 key 时传给后端。 */
  identityFile?: string;
  /** OpenSSH user certificate paired with identityFile. */
  certificateFile?: string;
  /** 加密私钥的口令，仅本次连接使用。 */
  keyPassphrase?: string;
  /** 密码认证，仅本次连接使用，绝不持久化。 */
  password?: string;
  /** 是否无提示接受首连未知主机密钥；默认不接受并弹窗确认。 */
  acceptUnknownHostKey?: boolean;
};

/** SSH 连接参数（与后端 ssh_open_v2 命令对齐）。无密码持久化。 */
export type SshConnectOptions = SshConnectEndpointOptions & {
  /** 注入远程 shell 集成（OSC 7 / OSC 133 / agent lifecycle），默认开启。 */
  injectShellIntegration?: boolean;
  /** A single independently authenticated ProxyJump endpoint. */
  jump?: SshConnectEndpointOptions;
  /** Multiplex a new shell onto this live logical session's TCP transport. */
  shareWithLogicalSessionId?: string;
};

export type SessionBindingV1 = {
  logicalSessionId: string;
  physicalPtyId: number;
  transportGeneration: string;
};

export type ForwardReconnectIntent =
  | {
      kind: "local";
      oldRuleId: string;
      oldBinding: SessionBindingV1;
      bindHost: string;
      requestedLocalPort: number;
      oldActualLocalPort: number;
      targetHost: string;
      targetPort: number;
    }
  | {
      kind: "dynamic";
      oldRuleId: string;
      oldBinding: SessionBindingV1;
      bindHost: string;
      requestedLocalPort: number;
      oldActualLocalPort: number;
    }
  | {
      kind: "remote";
      oldRuleId: string;
      oldBinding: SessionBindingV1;
      remoteBindHost: string;
      requestedRemotePort: number;
      oldActualRemotePort: number;
      localTargetHost: string;
      localTargetPort: number;
    };

export interface ForwardRebuildResult {
  oldRuleId: string;
  oldActualLocalPort: number;
  requestedLocalPort: number;
  newActualLocalPort?: number | null;
  newRuleId?: string | null;
  failure?: "fixedPortUnavailable" | "staleBinding" | "limitExceeded" | "invalidIntent" | "internal" | null;
}

export function snapshotReconnectForwards(binding: SessionBindingV1): Promise<ForwardReconnectIntent[]> {
  return invoke("ssh_forwarding_reconnect_snapshot", { binding });
}

export function rebuildReconnectForwards(
  binding: SessionBindingV1,
  intents: ForwardReconnectIntent[],
): Promise<ForwardRebuildResult[]> {
  return invoke("ssh_forwarding_reconnect_rebuild", { binding, intents });
}

export type SshOpenResultV2 = {
  physicalPtyId: number;
  transportGeneration: string;
  warnings: string[];
  binding?: SessionBindingV1;
};

export type SshCommandErrorV1 = {
  diagnostic: {
    schemaVersion: number;
    stage: string;
    code: string;
    severity: string;
    retryable: boolean;
    hopRole: "direct" | "jump" | "target";
  };
};

export class SshOpenCommandError extends Error {
  constructor(public readonly diagnostic: SshCommandErrorV1["diagnostic"]) {
    const hop = diagnostic.hopRole === "direct" ? "direct" : `${diagnostic.hopRole} hop`;
    const category = diagnostic.code === "authenticationFailed"
      ? "authentication failed"
      : diagnostic.code === "hostKeyRejected"
        ? "host key rejected"
        : diagnostic.code === "connectionRefused"
          ? "connection failed"
          : diagnostic.code === "invalidRequest"
            ? "request invalid"
            : diagnostic.code;
    super(`SSH ${hop} ${category}`);
    this.name = "SshOpenCommandError";
  }
}

function normalizeSshOpenError(error: unknown): Error | unknown {
  if (typeof error !== "object" || error === null || !("diagnostic" in error)) return error;
  const diagnostic = (error as Partial<SshCommandErrorV1>).diagnostic;
  if (!diagnostic
    || diagnostic.schemaVersion !== 1
    || !["direct", "jump", "target"].includes(diagnostic.hopRole)
    || typeof diagnostic.code !== "string") return error;
  return new SshOpenCommandError(diagnostic);
}

export type SshEndpointV1 = {
  host: string;
  port?: number | null;
  user: string;
  identityFile?: string | null;
  certificateFile?: string | null;
  keyPassphrase?: string | null;
  password?: string | null;
  authMethod?: SshAuthMethod | null;
  acceptUnknownHostKey?: boolean | null;
};

export type SshOpenRequestV2 = {
  logicalSessionId?: string | null;
  openAttemptId: string;
  endpoint: SshEndpointV1;
  jump?: SshEndpointV1 | null;
  shell: {
    cwd?: string | null;
    injectShellIntegration?: boolean | null;
    cols: number;
    rows: number;
  };
  shareWithLogicalSessionId?: string | null;
};

/** Typed v2 IPC adapter. `transportGeneration` is always backend-authored. */
export function sshOpenV2(
  request: SshOpenRequestV2,
  onEvent: Channel<PtyEvent>,
): Promise<SshOpenResultV2> {
  return invoke<SshOpenResultV2>("ssh_open_v2", { request, onEvent });
}

/**
 * 打开一个 SSH 远程会话。返回与 openPty 相同的 PtySession 接口——
 * write/resize/close 走同一套 pty_* 命令，对 xterm.js 完全透明。
 */
export async function openSshPty(
  logicalSessionId: string,
  cols: number,
  rows: number,
  handlers: PtyHandlers,
  conn: SshConnectOptions,
): Promise<PtySession> {
  const openAttemptId = nextSshOpenAttemptId();
  const openStartedAt = Date.now();
  const connectionAttributes = {
    auth_method: localUsageAuthMethod(conn.authMethod),
    route: conn.jump ? "jump" : "direct",
    ...(conn.jump ? { jump_auth_method: localUsageAuthMethod(conn.jump.authMethod) } : {}),
  };
  recordLocalUsageEvent({
    event: "ssh.session.open_requested",
    sessionId: logicalSessionId,
    correlationId: openAttemptId,
    outcome: "started",
    attributes: connectionAttributes,
  });
  for (const prompt of useUIStore.getState().keyboardInteractivePrompts) {
    if (prompt.origin.logicalSessionId !== logicalSessionId) continue;
    void answerKeyboardInteractivePrompt(prompt.promptId, null);
    useUIStore.getState().dismissKeyboardInteractivePrompt(prompt.promptId);
    useUIStore.getState().addToast({
      sessionId: logicalSessionId,
      title: t("ssh.keyboardInteractive.stale"),
      subtitle: t("ssh.keyboardInteractive.stale_detail"),
      variant: "warning",
    });
  }
  // Pending events are buffered until ssh_open_v2 returns the authoritative
  // backend generation. It replaces this private placeholder before any
  // event can be activated into the terminal.
  let generation = `pending:${openAttemptId}`;
  const previousGeneration = sshConnectionGenerations.get(logicalSessionId);
  sshOpenAttempts.set(logicalSessionId, openAttemptId);
  const channel = new Channel<PtyEvent>();
  const acknowledger = createOutputAcknowledger();
  const pendingPromptIds = new Set<string>();
  const pendingKeyboardPromptIds = new Set<string>();
  let physicalId: number | null = null;
  let publishable = false;
  let activated = false;
  let closed = false;
  let pendingEvents: PtyEvent[] = [];
  let hostKeyHopRole: "direct" | "jump" | "target" = conn.jump ? "jump" : "direct";
  let handshakeCount = 0;

  const observeHostKeyHop = (event: PtyEvent) => {
    if (conn.jump && event.type === "connectionStatus" && event.phase === "handshaking") {
      handshakeCount += 1;
      hostKeyHopRole = handshakeCount >= 2 ? "target" : "jump";
    }
  };

  const keyboardOriginMatchesConnection = (origin: Extract<PtyEvent, { type: "keyboardInteractivePrompt" }>["origin"]) => {
    const expectedRole = conn.jump ? (origin.hopRole === "jump" ? "jump" : "target") : "direct";
    const endpoint = expectedRole === "jump" ? conn.jump! : conn;
    return origin.logicalSessionId === logicalSessionId
      && origin.transportGeneration === openAttemptId
      && origin.hopRole === expectedRole
      && origin.user === endpoint.user
      && origin.host === endpoint.host
      && origin.port === (endpoint.port ?? 22);
  };

  const dispatch = (event: PtyEvent) => {
    switch (event.type) {
      case "data": {
        const bytes = decodeBase64(event.data);
        let acknowledged = false;
        handlers.onData(bytes, () => {
          if (acknowledged) return;
          acknowledged = true;
          acknowledger.acknowledge(bytes.byteLength);
        }, generation);
        break;
      }
      case "transportLost":
        handlers.onTransportLost?.(event.reason, generation);
        break;
      case "exit":
        handlers.onExit?.(event.code, generation);
        break;
      case "connectionStatus":
        handlers.onConnectionStatus?.(event.phase, generation);
        break;
      case "hostKeyPersistence":
        notifyHostKeyPersistence(event, logicalSessionId);
        break;
      case "hostKeyPrompt":
      case "keyboardInteractivePrompt":
        break;
    }
  };

  const acknowledgeDiscardedData = (event: PtyEvent) => {
    if (event.type === "data" && physicalId !== null) {
      acknowledger.acknowledge(decodeBase64(event.data).byteLength);
    }
  };

  channel.onmessage = (event) => {
    observeHostKeyHop(event);
    const published = sshConnectionGenerations.get(logicalSessionId) === openAttemptId;
    const latestPending = sshOpenAttempts.get(logicalSessionId) === openAttemptId;
    if (published && activated) {
      dispatch(event);
      return;
    }
    const currentCandidate = !closed && (latestPending || publishable);
    if (!currentCandidate) {
      if (event.type === "keyboardInteractivePrompt") {
        void answerKeyboardInteractivePrompt(event.promptId, null);
        useUIStore.getState().dismissKeyboardInteractivePrompt(event.promptId);
        useUIStore.getState().addToast({
          sessionId: logicalSessionId,
          title: t("ssh.keyboardInteractive.stale"),
          subtitle: t("ssh.keyboardInteractive.stale_detail"),
          variant: "warning",
        });
      }
      acknowledgeDiscardedData(event);
      return;
    }
    switch (event.type) {
      case "data":
      case "transportLost":
      case "exit":
        pendingEvents.push(event);
        break;
      case "connectionStatus":
        handlers.onPendingConnectionStatus?.(event.phase);
        pendingEvents.push(event);
        break;
      case "hostKeyPersistence":
        notifyHostKeyPersistence(event, logicalSessionId);
        break;
      case "hostKeyPrompt":
        handlers.onPendingConnectionStatus?.("verifyingHostKey");
        recordLocalUsageEvent({
          event: "ssh.host_key.prompted",
          sessionId: logicalSessionId,
          correlationId: event.promptId,
          outcome: "started",
          attributes: {
            hop_role: hostKeyHopRole,
            reason: event.reason === "unverifiable" ? "unverifiable" : "unknown",
          },
        });
        // Queue the confirmation in the UI store; an app-level dialog renders
        // the head and calls answerHostKeyPrompt with the user's decision. The
        // backend ssh_open call is blocked inside check_server_key until then.
        // Enqueue (not overwrite) so a second concurrent connection's prompt
        // doesn't evict an unanswered first one — each parked ssh_open needs its
        // own answer or it stays blocked until the session is closed.
        pendingPromptIds.add(event.promptId);
        useUIStore.getState().enqueueHostKeyPrompt({
          hopRole: hostKeyHopRole,
          promptId: event.promptId,
          host: event.host,
          port: event.port,
          fingerprint: event.fingerprint,
          keyType: event.keyType,
          reason: event.reason,
        });
        break;
      case "keyboardInteractivePrompt":
        if (!keyboardOriginMatchesConnection(event.origin)) {
          void answerKeyboardInteractivePrompt(event.promptId, null);
          useUIStore.getState().addToast({ sessionId: logicalSessionId, title: t("ssh.keyboardInteractive.stale"), subtitle: t("ssh.keyboardInteractive.stale_detail"), variant: "warning" });
          break;
        }
        pendingKeyboardPromptIds.add(event.promptId);
        useUIStore.getState().enqueueKeyboardInteractivePrompt({
          origin: event.origin,
          hopRole: event.origin.hopRole,
          promptId: event.promptId,
          name: event.name,
          instructions: event.instructions,
          prompts: event.prompts,
        });
        break;
    }
  };

  let result: SshOpenResultV2;
  try {
    // Strip every credential outside the explicitly selected strategy at the
    // IPC boundary. In particular, Password never forwards an identity path,
    // key passphrase, or any signal that could touch SSH Agent.
    const identityFile = conn.authMethod === "key" ? conn.identityFile ?? null : null;
    const keyPassphrase = conn.authMethod === "key" ? conn.keyPassphrase ?? null : null;
    const password = conn.authMethod === "password" ? conn.password ?? null : null;
    const endpoint: SshEndpointV1 = {
      host: conn.host,
      port: conn.port ?? null,
      user: conn.user,
      identityFile,
      certificateFile: conn.authMethod === "key" ? conn.certificateFile ?? null : null,
      keyPassphrase,
      password,
      authMethod: conn.authMethod ?? null,
      acceptUnknownHostKey: conn.acceptUnknownHostKey ?? null,
    };
    const jump = conn.jump ? endpointForSelectedAuth(conn.jump) : null;
    result = await sshOpenV2({
      logicalSessionId,
      openAttemptId,
      endpoint,
      jump,
      shell: {
        cwd: conn.cwd ?? null,
        injectShellIntegration: conn.injectShellIntegration ?? null,
        cols,
        rows,
      },
      shareWithLogicalSessionId: conn.shareWithLogicalSessionId ?? null,
    }, channel);
    if (!result.binding
      || result.binding.logicalSessionId !== logicalSessionId
      || result.binding.physicalPtyId !== result.physicalPtyId
      || result.binding.transportGeneration !== result.transportGeneration) {
      await invoke("pty_close", { id: result.physicalPtyId });
      throw new Error("SSH backend returned an inconsistent session binding");
    }
  } catch (error) {
    recordLocalUsageEvent({
      event: "ssh.session.open_failed",
      sessionId: logicalSessionId,
      correlationId: openAttemptId,
      durationMs: localUsageDuration(openStartedAt),
      success: false,
      outcome: "failed",
      errorCategory: localUsageErrorCategory(error),
      attributes: connectionAttributes,
    });
    // A host-key prompt can time out or its connection can fail while the
    // dialog is still queued. Remove only prompts owned by this open attempt;
    // otherwise the UI would show a dead fingerprint whose backend waiter is
    // already gone.
    for (const promptId of pendingPromptIds) {
      useUIStore.getState().dismissHostKeyPrompt(promptId);
    }
    for (const promptId of pendingKeyboardPromptIds) {
      useUIStore.getState().dismissKeyboardInteractivePrompt(promptId);
    }
    throw normalizeSshOpenError(error);
  } finally {
    if (sshOpenAttempts.get(logicalSessionId) === openAttemptId) {
      sshOpenAttempts.delete(logicalSessionId);
    }
    cancelledSshOpenAttempts.delete(openAttemptId);
  }
  const id = result.physicalPtyId;
  generation = result.transportGeneration;
  physicalId = id;
  acknowledger.setId(id);
  publishable = true;
  recordLocalUsageEvent({
    event: "ssh.session.opened",
    sessionId: logicalSessionId,
    correlationId: openAttemptId,
    durationMs: localUsageDuration(openStartedAt),
    success: true,
    outcome: "completed",
    attributes: connectionAttributes,
  });

  return {
    id,
    generation,
    activate: () => {
      if (closed || activated || sshConnectionGenerations.get(logicalSessionId) !== previousGeneration) {
        for (const event of pendingEvents) acknowledgeDiscardedData(event);
        pendingEvents = [];
        publishable = false;
        return false;
      }
      // The renderer installs its generation before activation. Only then can
      // initial shell output enter xterm; this prevents candidate bytes from
      // being parsed by the previous connection's terminal state.
      sshConnectionGenerations.set(logicalSessionId, openAttemptId);
      activated = true;
      publishable = false;
      const queued = pendingEvents;
      pendingEvents = [];
      for (const event of queued) dispatch(event);
      return true;
    },
    write: (data) => invoke("pty_write", { id, data }),
    resize: (c, r) => invoke("pty_resize", { id, cols: c, rows: r }),
    close: () => {
      closed = true;
      publishable = false;
      for (const event of pendingEvents) acknowledgeDiscardedData(event);
      pendingEvents = [];
      if (sshConnectionGenerations.get(logicalSessionId) === openAttemptId) {
        sshConnectionGenerations.delete(logicalSessionId);
      }
      // Always close this physical id. Generation identity only protects the
      // logical map; it must never leak an older backend connection.
      return invoke("pty_close", { id });
    },
  };
}

function endpointForSelectedAuth(conn: SshConnectEndpointOptions): SshEndpointV1 {
  return {
    host: conn.host,
    port: conn.port ?? null,
    user: conn.user,
    identityFile: conn.authMethod === "key" ? conn.identityFile ?? null : null,
    certificateFile: conn.authMethod === "key" ? conn.certificateFile ?? null : null,
    keyPassphrase: conn.authMethod === "key" ? conn.keyPassphrase ?? null : null,
    password: conn.authMethod === "password" ? conn.password ?? null : null,
    authMethod: conn.authMethod ?? null,
    acceptUnknownHostKey: conn.acceptUnknownHostKey ?? null,
  };
}
