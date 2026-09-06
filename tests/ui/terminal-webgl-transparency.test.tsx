import { render } from "@testing-library/react";
import { useRef } from "react";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { beforeEach, expect, test, vi } from "vitest";
import { useTerminalWebgl, type TerminalWebglRenderer } from "@/ui/useTerminalWebgl";

const platform = vi.hoisted(() => ({ isMac: false }));
vi.mock("@/ui/lib/platform", () => platform);

const webglInstances = vi.hoisted(() => [] as Array<{
  dispose: ReturnType<typeof vi.fn>;
}>);

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    dispose = vi.fn();
    onContextLoss = vi.fn();

    constructor() {
      webglInstances.push(this);
    }
  },
}));

interface HarnessProps {
  terminal: Terminal;
  sessionId: string;
  active: boolean;
  allowTransparency: boolean;
}

function WebglHarness({ terminal, sessionId, active, allowTransparency }: HarnessProps) {
  const termRef = useRef<Terminal | null>(terminal);
  const webglRef = useRef<TerminalWebglRenderer | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyRef = useRef(null);
  useTerminalWebgl(
    termRef,
    active,
    webglRef,
    sessionId,
    true,
    fitRef,
    ptyRef,
    allowTransparency,
  );
  return null;
}

function terminalStub(): Terminal {
  return {
    cols: 80,
    rows: 24,
    loadAddon: vi.fn(),
  } as unknown as Terminal;
}

beforeEach(() => {
  webglInstances.length = 0;
  platform.isMac = false;
});

test("macOS stays on DOM through activation, transparency changes and remount", () => {
  platform.isMac = true;
  const terminal = terminalStub();
  const view = render(
    <WebglHarness terminal={terminal} sessionId="mac" active allowTransparency={false} />,
  );
  view.rerender(
    <WebglHarness terminal={terminal} sessionId="mac" active={false} allowTransparency={false} />,
  );
  view.rerender(
    <WebglHarness terminal={terminal} sessionId="mac" active allowTransparency />,
  );
  expect(webglInstances).toHaveLength(0);
  expect(terminal.loadAddon).not.toHaveBeenCalled();
  view.unmount();

  const replacement = terminalStub();
  render(
    <WebglHarness terminal={replacement} sessionId="mac" active allowTransparency={false} />,
  );
  expect(webglInstances).toHaveLength(0);
  expect(replacement.loadAddon).not.toHaveBeenCalled();
});

test("WebGL renderer is recreated for both transparency directions but not repeated values", () => {
  const terminal = terminalStub();
  const view = render(
    <WebglHarness terminal={terminal} sessionId="toggle" active allowTransparency={false} />,
  );
  expect(webglInstances).toHaveLength(1);
  const opaque = webglInstances[0];

  view.rerender(
    <WebglHarness terminal={terminal} sessionId="toggle" active allowTransparency={false} />,
  );
  expect(webglInstances).toHaveLength(1);
  expect(opaque.dispose).not.toHaveBeenCalled();

  view.rerender(
    <WebglHarness terminal={terminal} sessionId="toggle" active allowTransparency />,
  );
  expect(opaque.dispose).toHaveBeenCalledTimes(1);
  expect(webglInstances).toHaveLength(2);
  const transparent = webglInstances[1];

  view.rerender(
    <WebglHarness terminal={terminal} sessionId="toggle" active allowTransparency={false} />,
  );
  expect(transparent.dispose).toHaveBeenCalledTimes(1);
  expect(webglInstances).toHaveLength(3);
});

test("inactive panes discard stale alpha renderers and remounts never reuse disposed contexts", () => {
  const terminal = terminalStub();
  const view = render(
    <WebglHarness terminal={terminal} sessionId="lifecycle" active allowTransparency />,
  );
  const transparent = webglInstances[0];

  view.rerender(
    <WebglHarness terminal={terminal} sessionId="lifecycle" active={false} allowTransparency={false} />,
  );
  expect(transparent.dispose).toHaveBeenCalledTimes(1);
  expect(webglInstances).toHaveLength(1);

  view.rerender(
    <WebglHarness terminal={terminal} sessionId="lifecycle" active allowTransparency={false} />,
  );
  expect(webglInstances).toHaveLength(2);
  const replacement = webglInstances[1];
  view.unmount();
  expect(replacement.dispose).toHaveBeenCalledTimes(1);

  const remounted = render(
    <WebglHarness terminal={terminalStub()} sessionId="lifecycle" active allowTransparency={false} />,
  );
  expect(webglInstances).toHaveLength(3);
  remounted.unmount();
});
