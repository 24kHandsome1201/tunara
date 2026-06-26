import { invoke, Channel } from "@tauri-apps/api/core";

export type PtyEvent =
  | { type: "data"; data: string }
  | { type: "exit"; code: number };

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
