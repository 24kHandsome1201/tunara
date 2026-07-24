import { invoke, Channel } from "@tauri-apps/api/core";
import { useUIStore } from "@/state/ui";
import { useSessionsStore } from "@/state/sessions";
import { t } from "@/modules/i18n";
import type { RemoteInfo } from "@/ui/types";
import { classifySshFailure } from "@/modules/ssh/failure-reason";
import type { SshAuthMethod } from "@/modules/ssh/hosts-model";
import type { BackendConnectionPhase } from "./connection-state";
import { recordTerminalBenchmarkExit, TERMINAL_BENCHMARK_MODE } from "./terminal-benchmark";

export type PtyEvent =
  | { type: "data"; data: string }
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
  | {
      type: "keyboardInteractivePrompt";
      promptId: string;
      name: string;
      instructions: string;
      prompts: Array<{ prompt: string; echo: boolean }>;
    };

/** Backend sentinel for an SSH transport that ended without ExitStatus. */
export const SSH_DISCONNECTED_EXIT_CODE = -2;

/** Reply to a pending SSH host-key prompt (backend ssh_open is parked on it). */
export async function answerHostKeyPrompt(promptId: string, accept: boolean): Promise<void> {
  await invoke("ssh_host_key_decision", { promptId, accept });
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

/**
 * Surface a failed SSH connection consistently: mark the session failed and
 * raise an error Toast (matching the rest of the app's error handling). No-op
 * for local sessions, which already show the inline red error line.
 */
export function reportSshOpenFailure(
  sessionId: string,
  remote: RemoteInfo | undefined,
  error: string,
): void {
  if (!remote) return;
  const reason = classifySshFailure(error);
  const store = useSessionsStore.getState();
  store.updateSession(sessionId, { runState: "failed" });
  store.handleConnectionEvent(sessionId, {
    type: "failed",
    transport: "ssh",
    reason,
    detail: error,
  });
  notifySshOpenFailure(sessionId, remote, error);
}

/** Show a failed replacement attempt without marking a still-live PTY failed. */
export function notifySshOpenFailure(
  sessionId: string,
  remote: RemoteInfo,
  error: string,
): void {
  useUIStore.getState().addToast({
    sessionId,
    title: `${remote.user}@${remote.host}`,
    subtitle: sshFailureReason(error),
    variant: "error",
  });
}

export type PtyHandlers = {
  onData: (bytes: Uint8Array, acknowledge: () => void) => void;
  onExit?: (code: number) => void;
  onConnectionStatus?: (phase: PtyConnectionStatusPhase) => void;
};

export type PtyConnectionStatusPhase = BackendConnectionPhase | "verifyingHostKey";

export function recordPtyConnectionStatus(sessionId: string, phase: PtyConnectionStatusPhase): void {
  useSessionsStore.getState().handleConnectionEvent(
    sessionId,
    phase === "verifyingHostKey"
      ? { type: "hostKeyPrompt" }
      : { type: "backendPhase", transport: "ssh", phase },
  );
}

export function recordPtyExit(sessionId: string, remote: boolean, code: number): void {
  if (TERMINAL_BENCHMARK_MODE) recordTerminalBenchmarkExit(sessionId, code);
  useSessionsStore.getState().handleConnectionEvent(sessionId, {
    type: "exit",
    transport: remote ? "ssh" : "local",
    code,
    disconnected: remote && code === SSH_DISCONNECTED_EXIT_CODE,
  });
}

export type PtySession = {
  id: number;
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
  const acknowledger = createOutputAcknowledger();
  const channel = new Channel<PtyEvent>();
  channel.onmessage = (event) => {
    switch (event.type) {
      case "data": {
        const bytes = decodeBase64(event.data);
        let acknowledged = false;
        handlers.onData(bytes, () => {
          if (acknowledged) return;
          acknowledged = true;
          acknowledger.acknowledge(bytes.byteLength);
        });
        break;
      }
      case "exit":
        handlers.onExit?.(event.code);
        break;
      case "connectionStatus":
        handlers.onConnectionStatus?.(event.phase);
        break;
    }
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
    write: (data) => invoke("pty_write", { id, data }),
    resize: (c, r) => invoke("pty_resize", { id, cols: c, rows: r }),
    close: () => invoke("pty_close", { id }),
  };
}

/** 远程会话连接信息（与 Session.remote / RemoteInfo 对齐）。 */
export type RemoteOpenInfo = {
  host: string;
  port: number;
  user: string;
  authMethod?: SshAuthMethod;
  identityFile?: string;
  /** 加密私钥口令，仅本次连接，绝不持久化。 */
  keyPassphrase?: string;
  /** 密码认证，仅本次连接，绝不持久化。 */
  password?: string;
  /** Phase 4：注入远程 shell 集成（远程 cwd / 命令边界 / agent 检测）。 */
  injectShellIntegration?: boolean;
};

/**
 * 按会话类型开 PTY：有 remote 走 SSH，否则走本地 shell。
 * 两者返回同一个 PtySession 接口，调用方（TerminalView）无需分支。
 */
export function openSessionPty(
  logicalSessionId: string,
  cols: number,
  rows: number,
  handlers: PtyHandlers,
  opts: { cwd?: string; remote?: RemoteOpenInfo },
): Promise<PtySession> {
  if (opts.remote) {
    return openSshPty(logicalSessionId, cols, rows, handlers, {
      host: opts.remote.host,
      port: opts.remote.port,
      user: opts.remote.user,
      authMethod: opts.remote.authMethod,
      cwd: opts.cwd?.startsWith("/") ? opts.cwd : undefined,
      identityFile: opts.remote.identityFile,
      keyPassphrase: opts.remote.keyPassphrase,
      password: opts.remote.password,
      injectShellIntegration: opts.remote.injectShellIntegration,
    });
  }
  // A local reopen of the same logical session also supersedes any old SSH
  // Channel. The backend independently cancels a still-pending SSH publish.
  sshConnectionGenerations.delete(logicalSessionId);
  return openPty(logicalSessionId, cols, rows, handlers, opts.cwd);
}

/** SSH 连接参数（与后端 ssh_open 命令对齐）。无密码持久化。 */
export type SshConnectOptions = {
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
  /** 加密私钥的口令，仅本次连接使用。 */
  keyPassphrase?: string;
  /** 密码认证，仅本次连接使用，绝不持久化。 */
  password?: string;
  /** 是否无提示接受首连未知主机密钥；默认不接受并弹窗确认。 */
  acceptUnknownHostKey?: boolean;
  /** 注入远程 shell 集成（OSC 7 / OSC 133 / agent lifecycle），默认开启。 */
  injectShellIntegration?: boolean;
};

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
  const previousGeneration = sshConnectionGenerations.get(logicalSessionId);
  sshOpenAttempts.set(logicalSessionId, openAttemptId);
  const channel = new Channel<PtyEvent>();
  const acknowledger = createOutputAcknowledger();
  const pendingPromptIds = new Set<string>();
  const pendingKeyboardPromptIds = new Set<string>();
  channel.onmessage = (event) => {
    const published = sshConnectionGenerations.get(logicalSessionId) === openAttemptId;
    const latestPending = sshOpenAttempts.get(logicalSessionId) === openAttemptId;
    if (!published && !latestPending) return;
    switch (event.type) {
      case "data": {
        const bytes = decodeBase64(event.data);
        let acknowledged = false;
        handlers.onData(bytes, () => {
          if (acknowledged) return;
          acknowledged = true;
          acknowledger.acknowledge(bytes.byteLength);
        });
        break;
      }
      case "exit":
        handlers.onExit?.(event.code);
        break;
      case "connectionStatus":
        handlers.onConnectionStatus?.(event.phase);
        break;
      case "hostKeyPrompt":
        handlers.onConnectionStatus?.("verifyingHostKey");
        // Queue the confirmation in the UI store; an app-level dialog renders
        // the head and calls answerHostKeyPrompt with the user's decision. The
        // backend ssh_open call is blocked inside check_server_key until then.
        // Enqueue (not overwrite) so a second concurrent connection's prompt
        // doesn't evict an unanswered first one — each parked ssh_open needs its
        // own answer or it stays blocked until the session is closed.
        pendingPromptIds.add(event.promptId);
        useUIStore.getState().enqueueHostKeyPrompt({
          promptId: event.promptId,
          host: event.host,
          port: event.port,
          fingerprint: event.fingerprint,
          keyType: event.keyType,
          reason: event.reason,
        });
        break;
      case "keyboardInteractivePrompt":
        pendingKeyboardPromptIds.add(event.promptId);
        useUIStore.getState().enqueueKeyboardInteractivePrompt({
          promptId: event.promptId,
          name: event.name,
          instructions: event.instructions,
          prompts: event.prompts,
        });
        break;
    }
  };

  let id: number;
  try {
    // Strip every credential outside the explicitly selected strategy at the
    // IPC boundary. In particular, Password never forwards an identity path,
    // key passphrase, or any signal that could touch SSH Agent.
    const identityFile = conn.authMethod === "key" ? conn.identityFile ?? null : null;
    const keyPassphrase = conn.authMethod === "key" ? conn.keyPassphrase ?? null : null;
    const password = conn.authMethod === "password" ? conn.password ?? null : null;
    id = await invoke<number>("ssh_open", {
      logicalSessionId,
      openAttemptId,
      host: conn.host,
      port: conn.port ?? null,
      user: conn.user,
      cwd: conn.cwd ?? null,
      identityFile,
      keyPassphrase,
      password,
      authMethod: conn.authMethod ?? null,
      acceptUnknownHostKey: conn.acceptUnknownHostKey ?? null,
      injectShellIntegration: conn.injectShellIntegration ?? null,
      cols,
      rows,
      onEvent: channel,
    });
  } catch (error) {
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
    throw error;
  } finally {
    if (sshOpenAttempts.get(logicalSessionId) === openAttemptId) {
      sshOpenAttempts.delete(logicalSessionId);
    }
    cancelledSshOpenAttempts.delete(openAttemptId);
  }
  acknowledger.setId(id);
  // Keep the old published Channel live while authentication is pending. The
  // backend swaps physical PTYs immediately before ssh_open returns; publish
  // the matching renderer generation only now. A late older response must not
  // overwrite a generation already published by a newer attempt.
  if (sshConnectionGenerations.get(logicalSessionId) === previousGeneration) {
    sshConnectionGenerations.set(logicalSessionId, openAttemptId);
  }

  return {
    id,
    write: (data) => invoke("pty_write", { id, data }),
    resize: (c, r) => invoke("pty_resize", { id, cols: c, rows: r }),
    close: () => {
      if (sshConnectionGenerations.get(logicalSessionId) === openAttemptId) {
        sshConnectionGenerations.delete(logicalSessionId);
      }
      // Always close this physical id. Generation identity only protects the
      // logical map; it must never leak an older backend connection.
      return invoke("pty_close", { id });
    },
  };
}
