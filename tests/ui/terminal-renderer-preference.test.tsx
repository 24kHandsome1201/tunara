import { act, render } from "@testing-library/react";
import { useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import { beforeEach, expect, test, vi } from "vitest";
import type { TerminalRendererPreference } from "@/modules/terminal/lib/terminal-renderer-policy";
import {
  getTerminalGpuHealth,
  resetTerminalGpuHealth,
  useTerminalWebgl,
  type TerminalWebglRenderer,
} from "@/ui/useTerminalWebgl";

vi.mock("@/ui/lib/platform", () => ({ isMac: false }));

interface FakeAddon {
  dispose: ReturnType<typeof vi.fn>;
  onContextLoss: ReturnType<typeof vi.fn>;
  loseContext: () => void;
}

const webglInstances = vi.hoisted(() => [] as FakeAddon[]);

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class implements FakeAddon {
    dispose = vi.fn();
    private contextLossHandler: (() => void) | null = null;
    onContextLoss = vi.fn((handler: () => void) => {
      this.contextLossHandler = handler;
      return { dispose: () => {} };
    });

    loseContext() {
      this.contextLossHandler?.();
    }

    constructor() {
      webglInstances.push(this);
    }
  },
}));

const selfCheck = vi.hoisted(() => ({
  status: "passed" as "passed" | "failed" | "unavailable",
  runs: 0,
  resolvers: [] as Array<() => void>,
}));

vi.mock("@/modules/terminal/lib/terminal-glyph-self-check", () => ({
  runGlyphSelfCheck: vi.fn(() => {
    selfCheck.runs += 1;
    return new Promise((resolve) => {
      selfCheck.resolvers.push(() => resolve({
        status: selfCheck.status,
        reason: selfCheck.status === "passed" ? null : "probe",
        durationMs: 1,
        metrics: null,
        glyphs: null,
        framesWaited: 1,
      }));
    });
  }),
}));

async function flushLazyLoads() {
  // The addon and the self-check are both dynamic imports; let those
  // promise chains flush.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function settleSelfCheck() {
  await flushLazyLoads();
  const resolvers = selfCheck.resolvers.splice(0);
  await act(async () => {
    for (const resolve of resolvers) resolve();
  });
  await flushLazyLoads();
}

interface HarnessProps {
  terminal: Terminal;
  sessionId: string;
  active?: boolean;
  preference: TerminalRendererPreference;
  webglRef?: { current: TerminalWebglRenderer | null };
}

function Harness({ terminal, sessionId, active = true, preference, webglRef: external }: HarnessProps) {
  const termRef = useRef<Terminal | null>(terminal);
  const internal = useRef<TerminalWebglRenderer | null>(null);
  useTerminalWebgl(
    termRef,
    active,
    external ?? internal,
    sessionId,
    true,
    undefined,
    undefined,
    false,
    { preference, fontFamily: "JetBrains Mono", fontSize: 14 },
  );
  return null;
}

function terminalStub(): Terminal {
  return {
    cols: 80,
    rows: 24,
    loadAddon: vi.fn(),
    refresh: vi.fn(),
  } as unknown as Terminal;
}

beforeEach(() => {
  webglInstances.length = 0;
  selfCheck.status = "passed";
  selfCheck.runs = 0;
  selfCheck.resolvers.length = 0;
  resetTerminalGpuHealth();
});

test("compat never runs the self-check or loads WebGL", async () => {
  const terminal = terminalStub();
  render(<Harness terminal={terminal} sessionId="compat" preference="compat" />);
  await settleSelfCheck();
  expect(selfCheck.runs).toBe(0);
  expect(webglInstances).toHaveLength(0);
  expect(terminal.loadAddon).not.toHaveBeenCalled();
});

test("gpu loads WebGL immediately without a self-check", async () => {
  const terminal = terminalStub();
  const webglRef = { current: null as TerminalWebglRenderer | null };
  render(<Harness terminal={terminal} sessionId="gpu" preference="gpu" webglRef={webglRef} />);
  await flushLazyLoads();
  expect(selfCheck.runs).toBe(0);
  expect(webglInstances).toHaveLength(1);
  expect(terminal.loadAddon).toHaveBeenCalledTimes(1);
  expect(webglRef.current).toBe(webglInstances[0]);
});

test("auto stays on DOM until the self-check passes, then loads WebGL once per pane", async () => {
  const terminal = terminalStub();
  const webglRef = { current: null as TerminalWebglRenderer | null };
  const view = render(<Harness terminal={terminal} sessionId="auto" preference="auto" webglRef={webglRef} />);
  expect(webglInstances).toHaveLength(0);
  expect(getTerminalGpuHealth().selfCheck).toBe("pending");
  await settleSelfCheck();
  expect(selfCheck.runs).toBe(1);
  expect(getTerminalGpuHealth().selfCheck).toBe("passed");
  expect(webglInstances).toHaveLength(1);
  expect(terminal.loadAddon).toHaveBeenCalledTimes(1);
  expect(webglRef.current).toBe(webglInstances[0]);

  // A second pane reuses the cached verdict instead of probing again.
  const second = terminalStub();
  view.rerender(
    <>
      <Harness terminal={terminal} sessionId="auto" preference="auto" webglRef={webglRef} />
      <Harness terminal={second} sessionId="auto-2" preference="auto" />
    </>,
  );
  await settleSelfCheck();
  expect(selfCheck.runs).toBe(1);
  expect(webglInstances).toHaveLength(2);
  expect(second.loadAddon).toHaveBeenCalledTimes(1);
});

test.each(["failed", "unavailable"] as const)("auto keeps DOM when the self-check reports %s", async (status) => {
  selfCheck.status = status;
  const terminal = terminalStub();
  render(<Harness terminal={terminal} sessionId={`auto-${status}`} preference="auto" />);
  await settleSelfCheck();
  expect(getTerminalGpuHealth().selfCheck).toBe(status);
  expect(webglInstances).toHaveLength(0);
  expect(terminal.loadAddon).not.toHaveBeenCalled();
});

test("auto pins every pane to DOM after a WebGL context loss", async () => {
  const first = terminalStub();
  const second = terminalStub();
  const firstRef = { current: null as TerminalWebglRenderer | null };
  const secondRef = { current: null as TerminalWebglRenderer | null };
  render(
    <>
      <Harness terminal={first} sessionId="loss-1" preference="auto" webglRef={firstRef} />
      <Harness terminal={second} sessionId="loss-2" preference="auto" webglRef={secondRef} />
    </>,
  );
  await settleSelfCheck();
  expect(webglInstances).toHaveLength(2);
  expect(firstRef.current).toBe(webglInstances[0]);
  expect(secondRef.current).toBe(webglInstances[1]);

  act(() => { webglInstances[0].loseContext(); });
  expect(getTerminalGpuHealth().gpuFault).toBe("context-lost");
  expect(webglInstances[0].dispose).toHaveBeenCalled();
  expect(first.refresh).toHaveBeenCalled();
  expect(firstRef.current).toBeNull();
  // The healthy sibling is torn down too: the process is no longer trusted with WebGL.
  expect(webglInstances[1].dispose).toHaveBeenCalled();
  expect(second.refresh).toHaveBeenCalled();
  expect(secondRef.current).toBeNull();

  // New panes stay on DOM for the rest of the process without re-probing.
  const third = terminalStub();
  render(<Harness terminal={third} sessionId="loss-3" preference="auto" />);
  await settleSelfCheck();
  expect(selfCheck.runs).toBe(1);
  expect(webglInstances).toHaveLength(2);
  expect(third.loadAddon).not.toHaveBeenCalled();
});

test("gpu keeps the per-pane fallback on context loss without pinning the process", async () => {
  const first = terminalStub();
  const second = terminalStub();
  const firstRef = { current: null as TerminalWebglRenderer | null };
  const secondRef = { current: null as TerminalWebglRenderer | null };
  render(
    <>
      <Harness terminal={first} sessionId="gpu-loss-1" preference="gpu" webglRef={firstRef} />
      <Harness terminal={second} sessionId="gpu-loss-2" preference="gpu" webglRef={secondRef} />
    </>,
  );
  await flushLazyLoads();
  expect(webglInstances).toHaveLength(2);
  act(() => { webglInstances[0].loseContext(); });
  expect(getTerminalGpuHealth().gpuFault).toBeNull();
  expect(webglInstances[0].dispose).toHaveBeenCalled();
  expect(firstRef.current).toBeNull();
  expect(webglInstances[1].dispose).not.toHaveBeenCalled();
  expect(secondRef.current).toBe(webglInstances[1]);
});

test("auto records init failures as a GPU fault and falls back to DOM", async () => {
  const terminal = terminalStub();
  (terminal.loadAddon as ReturnType<typeof vi.fn>).mockImplementation(() => { throw new Error("no webgl2"); });
  render(<Harness terminal={terminal} sessionId="init-fail" preference="auto" />);
  await settleSelfCheck();
  expect(getTerminalGpuHealth().gpuFault).toBe("init-failed");
  expect(webglInstances).toHaveLength(1);
  expect(webglInstances[0].dispose).not.toHaveBeenCalled();
});

test("switching the preference to compat tears down a live WebGL renderer", async () => {
  const terminal = terminalStub();
  const webglRef = { current: null as TerminalWebglRenderer | null };
  const view = render(<Harness terminal={terminal} sessionId="switch" preference="gpu" webglRef={webglRef} />);
  await flushLazyLoads();
  expect(webglInstances).toHaveLength(1);
  view.rerender(<Harness terminal={terminal} sessionId="switch" preference="compat" webglRef={webglRef} />);
  expect(webglInstances[0].dispose).toHaveBeenCalled();
  expect(terminal.refresh).toHaveBeenCalled();
  expect(webglRef.current).toBeNull();
});

test("without an explicit policy the hook follows the persisted Settings renderer", async () => {
  const { useUIStore } = await import("@/state/ui");
  function StoreHarness({ terminal, sessionId }: { terminal: Terminal; sessionId: string }) {
    const termRef = useRef<Terminal | null>(terminal);
    const webglRef = useRef<TerminalWebglRenderer | null>(null);
    useTerminalWebgl(termRef, true, webglRef, sessionId, true);
    return null;
  }
  expect(useUIStore.getState().terminalRenderer).toBe("auto");
  const terminal = terminalStub();
  render(<StoreHarness terminal={terminal} sessionId="store" />);
  expect(webglInstances).toHaveLength(0);
  await settleSelfCheck();
  expect(selfCheck.runs).toBe(1);
  expect(webglInstances).toHaveLength(1);

  act(() => { useUIStore.getState().setTerminalRenderer("compat"); });
  await flushLazyLoads();
  expect(webglInstances[0].dispose).toHaveBeenCalled();
  expect(terminal.refresh).toHaveBeenCalled();
  act(() => { useUIStore.getState().setTerminalRenderer("auto"); });
});
