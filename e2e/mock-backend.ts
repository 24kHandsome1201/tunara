import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";

type InvokeArgs = Record<string, unknown> | undefined;

type ChannelLike = { id: number };

type MockPty = {
  id: number;
  logicalSessionId: string;
  channel: ChannelLike;
  nextIndex: number;
  cols: number;
  rows: number;
  writes: string[];
  closed: boolean;
};

/** Mirrors the backend's snake_case `RawHostProfile`. */
export type MockSshHost = {
  id: string;
  label: string;
  host: string;
  port: number;
  user: string;
  auth_method: "agent" | "key" | "password";
  identity_file: string;
};

export type MockBackendState = {
  calls: Array<{ cmd: string; args: InvokeArgs }>;
  unhandled: string[];
  ptys: MockPty[];
  savedConfigs: unknown[];
  store: Map<string, unknown>;
  sshHosts: MockSshHost[];
};

export type TunaraE2EHandle = {
  state: MockBackendState;
  emitPtyOutput: (ptyId: number, text: string) => void;
  ptyWrites: (ptyId?: number) => string;
  openPtyIds: () => number[];
  callCount: (cmd: string) => number;
};

declare global {
  interface Window {
    __TUNARA_E2E__?: TunaraE2EHandle;
    __TAURI_OS_PLUGIN_INTERNALS__?: Record<string, string>;
    __TAURI_INTERNALS__: {
      runCallback: (id: number, data: unknown) => void;
    } & Record<string, unknown>;
  }
}

const PROMPT = "\x1b]133;A\x07e2e$ \x1b]133;B\x07";
const HOME = "/home/e2e";

function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function isChannel(value: unknown): value is ChannelLike {
  return typeof value === "object" && value !== null && typeof (value as ChannelLike).id === "number";
}

function sendChannel(pty: MockPty, message: unknown): void {
  window.__TAURI_INTERNALS__.runCallback(pty.channel.id, { index: pty.nextIndex, message });
  pty.nextIndex += 1;
}

function emitData(pty: MockPty, text: string): void {
  if (pty.closed) return;
  sendChannel(pty, { type: "data", data: encodeBase64(text) });
}

/** Echo like a cooked-mode shell: printable input is echoed, Enter ends the line and re-prompts. */
function echoInput(pty: MockPty, data: string): void {
  let out = "";
  for (const ch of data) {
    if (ch === "\r") out += `\r\n${PROMPT}`;
    else if (ch === "\x7f") out += "\b \b";
    else if (ch >= " ") out += ch;
  }
  if (out) emitData(pty, out);
}

const DEFAULT_SSH_HOSTS: MockSshHost[] = [
  { id: "e2e-host-1", label: "staging", host: "staging.example.test", port: 22, user: "deploy", auth_method: "agent", identity_file: "" },
];

export function installMockBackend(): TunaraE2EHandle {
  const state: MockBackendState = {
    calls: [],
    unhandled: [],
    ptys: [],
    savedConfigs: [],
    store: new Map(),
    sshHosts: DEFAULT_SSH_HOSTS.map((host) => ({ ...host })),
  };
  let nextPtyId = 1;
  let nextRid = 1;

  const ptyById = (id: unknown) => state.ptys.find((pty) => pty.id === id);

  const handlers: Record<string, (args: InvokeArgs) => unknown> = {
    load_config: () => ({ path: `${HOME}/.config/tunara/config.toml`, config: { keybindings: {} }, error: null }),
    save_config: (args) => {
      state.savedConfigs.push(args?.config);
      return null;
    },
    workspace_store_file_state: () => "missing",
    pty_open: (args) => {
      const channel = args?.onEvent;
      if (!isChannel(channel)) throw new Error("pty_open: missing channel");
      const pty: MockPty = {
        id: nextPtyId++,
        logicalSessionId: asString(args?.logicalSessionId),
        channel,
        nextIndex: 0,
        cols: asNumber(args?.cols, 80),
        rows: asNumber(args?.rows, 24),
        writes: [],
        closed: false,
      };
      state.ptys.push(pty);
      setTimeout(() => {
        sendChannel(pty, { type: "connectionStatus", phase: "ready" });
        emitData(pty, `\x1b]7;file://e2e${HOME}\x07${PROMPT}`);
      }, 0);
      return pty.id;
    },
    pty_write: (args) => {
      const pty = ptyById(args?.id);
      if (!pty) throw new Error("pty_write: unknown pty");
      const data = asString(args?.data);
      pty.writes.push(data);
      echoInput(pty, data);
      return null;
    },
    pty_resize: (args) => {
      const pty = ptyById(args?.id);
      if (pty) {
        pty.cols = asNumber(args?.cols, pty.cols);
        pty.rows = asNumber(args?.rows, pty.rows);
      }
      return null;
    },
    pty_close: (args) => {
      const pty = ptyById(args?.id);
      if (pty) pty.closed = true;
      return null;
    },
    pty_output_ack: () => null,
    ssh_hosts_load: () => state.sshHosts,
    ssh_hosts_save: (args) => {
      const profile = args?.profile as MockSshHost;
      state.sshHosts = [...state.sshHosts.filter((host) => host.id !== profile.id), profile];
      return state.sshHosts;
    },
    ssh_hosts_remove: (args) => {
      state.sshHosts = state.sshHosts.filter((host) => host.id !== args?.id);
      return state.sshHosts;
    },
    ssh_hosts_import_config: () => ({ imported: [], skipped: 0, diagnostics: [] }),
    ssh_known_hosts_list_v1: () => [],
    fs_read_dir: () => [],
    fs_resolve_dir: (args) => asString(args?.path) || HOME,
    git_status: () => null,
    git_diff: () => "",
    git_workspace_context: () => null,
    git_watch: () => null,
    git_unwatch: () => null,
    git_ahead_behind: () => null,
    herdr_status: () => null,
    resolve_all_bins: () => [],
    fs_scan_recent_repos: () => [],
    set_window_background_blur: () => null,
    agent_preflight: () => null,
    ssh_transfer_journal_load: () => [],
    ssh_transfer_journal_list_owned_partials: () => [],
    "plugin:store|load": () => nextRid++,
    "plugin:store|get_store": () => null,
    "plugin:store|get": (args) => {
      const key = asString(args?.key);
      return [state.store.get(key) ?? null, state.store.has(key)];
    },
    "plugin:store|set": (args) => {
      state.store.set(asString(args?.key), args?.value);
      return null;
    },
    "plugin:store|has": (args) => state.store.has(asString(args?.key)),
    "plugin:store|delete": (args) => state.store.delete(asString(args?.key)),
    "plugin:store|clear": () => {
      state.store.clear();
      return null;
    },
    "plugin:store|keys": () => [...state.store.keys()],
    "plugin:store|values": () => [...state.store.values()],
    "plugin:store|entries": () => [...state.store.entries()],
    "plugin:store|length": () => state.store.size,
    "plugin:app|version": () => "0.0.0-e2e",
    "plugin:app|name": () => "Tunara",
    "plugin:updater|check": () => null,
    "plugin:autostart|is_enabled": () => false,
    "plugin:window|scale_factor": () => 1,
    "plugin:window|is_focused": () => true,
    "plugin:window|is_fullscreen": () => false,
    "plugin:window|is_maximized": () => false,
    "plugin:window|theme": () => "light",
  };

  mockWindows("main");
  // The golden paths use macOS defaults (⌘D, ⌘K). Some modules pick defaults
  // from `navigator.platform` rather than plugin-os, so pin both to macOS to
  // keep the host OS (e.g. Linux CI) from leaking into the app.
  Object.defineProperty(window.navigator, "platform", { configurable: true, get: () => "MacIntel" });
  window.__TAURI_OS_PLUGIN_INTERNALS__ = {
    platform: "macos",
    family: "unix",
    os_type: "macos",
    version: "15.0.0",
    arch: "aarch64",
    eol: "\n",
    exe_extension: "",
  };
  mockIPC(
    (cmd, args) => {
      const payload = args as InvokeArgs;
      state.calls.push({ cmd, args: payload });
      const handler = handlers[cmd];
      if (handler) return handler(payload);
      if (!state.unhandled.includes(cmd)) state.unhandled.push(cmd);
      return null;
    },
    { shouldMockEvents: true },
  );

  const handle: TunaraE2EHandle = {
    state,
    emitPtyOutput: (ptyId, text) => {
      const pty = ptyById(ptyId);
      if (!pty) throw new Error(`unknown pty ${ptyId}`);
      emitData(pty, text);
    },
    ptyWrites: (ptyId) => state.ptys.filter((pty) => ptyId === undefined || pty.id === ptyId).flatMap((pty) => pty.writes).join(""),
    openPtyIds: () => state.ptys.filter((pty) => !pty.closed).map((pty) => pty.id),
    callCount: (cmd) => state.calls.filter((call) => call.cmd === cmd).length,
  };
  window.__TUNARA_E2E__ = handle;
  return handle;
}
