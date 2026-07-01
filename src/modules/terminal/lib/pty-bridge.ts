import { invoke, Channel } from "@tauri-apps/api/core";
import { useUIStore } from "@/state/ui";
import { useSessionsStore } from "@/state/sessions";
import { t } from "@/modules/i18n";
import type { RemoteInfo } from "@/ui/types";
import { classifySshFailure } from "@/modules/ssh/failure-reason";

export type PtyEvent =
  | { type: "data"; data: string }
  | { type: "exit"; code: number }
  | {
      type: "hostKeyPrompt";
      promptId: string;
      host: string;
      port: number;
      fingerprint: string;
      keyType: string;
      /** "unknown" = first contact (accepting persists); "unverifiable" = key
       *  couldn't be confirmed against a hashed/wildcard entry (not persisted). */
      reason: string;
    };

/** Reply to a pending SSH host-key prompt (backend ssh_open is parked on it). */
export async function answerHostKeyPrompt(promptId: string, accept: boolean): Promise<void> {
  try {
    await invoke("ssh_host_key_decision", { promptId, accept });
  } catch {
    /* prompt may have already resolved/timed out; nothing to do */
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
  useSessionsStore.getState().updateSession(sessionId, { runState: "failed" });
  useUIStore.getState().addToast({
    sessionId,
    title: `${remote.user}@${remote.host}`,
    subtitle: sshFailureReason(error),
    variant: "error",
  });
}

export type PtyHandlers = {
  onData: (bytes: Uint8Array) => void;
  onExit?: (code: number) => void;
};

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

export async function openPty(
  logicalSessionId: string,
  cols: number,
  rows: number,
  handlers: PtyHandlers,
  cwd?: string,
): Promise<PtySession> {
  const channel = new Channel<PtyEvent>();
  channel.onmessage = (event) => {
    switch (event.type) {
      case "data":
        handlers.onData(decodeBase64(event.data));
        break;
      case "exit":
        handlers.onExit?.(event.code);
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
      identityFile: opts.remote.identityFile,
      keyPassphrase: opts.remote.keyPassphrase,
      password: opts.remote.password,
      injectShellIntegration: opts.remote.injectShellIntegration,
    });
  }
  return openPty(logicalSessionId, cols, rows, handlers, opts.cwd);
}

/** SSH 连接参数（与后端 ssh_open 命令对齐）。无密码持久化。 */
export type SshConnectOptions = {
  host: string;
  port?: number;
  user: string;
  /** 私钥文件路径；缺省走 ssh-agent。 */
  identityFile?: string;
  /** 加密私钥的口令，仅本次连接使用。 */
  keyPassphrase?: string;
  /** 密码认证，仅本次连接使用，绝不持久化。 */
  password?: string;
  /** 首连未知主机密钥是否接受（TOFU），默认 true。 */
  acceptUnknownHostKey?: boolean;
  /** Phase 4：注入远程 shell 集成（OSC 7 / OSC 133），默认 false。 */
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
  const channel = new Channel<PtyEvent>();
  channel.onmessage = (event) => {
    switch (event.type) {
      case "data":
        handlers.onData(decodeBase64(event.data));
        break;
      case "exit":
        handlers.onExit?.(event.code);
        break;
      case "hostKeyPrompt":
        // Queue the confirmation in the UI store; an app-level dialog renders
        // the head and calls answerHostKeyPrompt with the user's decision. The
        // backend ssh_open call is blocked inside check_server_key until then.
        // Enqueue (not overwrite) so a second concurrent connection's prompt
        // doesn't evict an unanswered first one — each parked ssh_open needs its
        // own answer or it stays blocked until the session is closed.
        useUIStore.getState().enqueueHostKeyPrompt({
          promptId: event.promptId,
          host: event.host,
          port: event.port,
          fingerprint: event.fingerprint,
          keyType: event.keyType,
          reason: event.reason,
        });
        break;
    }
  };

  const id = await invoke<number>("ssh_open", {
    logicalSessionId,
    host: conn.host,
    port: conn.port ?? null,
    user: conn.user,
    identityFile: conn.identityFile ?? null,
    keyPassphrase: conn.keyPassphrase ?? null,
    password: conn.password ?? null,
    acceptUnknownHostKey: conn.acceptUnknownHostKey ?? null,
    injectShellIntegration: conn.injectShellIntegration ?? null,
    cols,
    rows,
    onEvent: channel,
  });

  return {
    id,
    write: (data) => invoke("pty_write", { id, data }),
    resize: (c, r) => invoke("pty_resize", { id, cols: c, rows: r }),
    close: () => invoke("pty_close", { id }),
  };
}
