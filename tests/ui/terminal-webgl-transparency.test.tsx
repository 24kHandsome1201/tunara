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
  ready?: boolean;
}

function WebglHarness({ terminal, sessionId, active, allowTransparency, ready = true }: HarnessProps) {
  const termRef = useRef<Terminal | null>(null);
  termRef.current = ready ? terminal : null;
  const webglRef = useRef<TerminalWebglRenderer | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyRef = useRef(null);
  useTerminalWebgl(
    termRef,
    active,
    webglRef,
    sessionId,
    ready,
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

test.each([true, false])("DOM survives activation, both alpha changes and remount (isMac=%s)", (isMac) => {
  platform.isMac = isMac;
  const terminal = terminalStub();
  const view = render(
    <WebglHarness terminal={terminal} sessionId="lifecycle" active allowTransparency={false} />,
  );
  view.rerender(
    <WebglHarness terminal={terminal} sessionId="lifecycle" active={false} allowTransparency={false} />,
  );
  view.rerender(
    <WebglHarness terminal={terminal} sessionId="lifecycle" active allowTransparency />,
  );
  view.rerender(
    <WebglHarness terminal={terminal} sessionId="lifecycle" active allowTransparency={false} />,
  );
  expect(webglInstances).toHaveLength(0);
  expect(terminal.loadAddon).not.toHaveBeenCalled();
  view.unmount();

  const replacement = terminalStub();
  render(
    <WebglHarness terminal={replacement} sessionId="lifecycle" active allowTransparency={false} />,
  );
  expect(webglInstances).toHaveLength(0);
  expect(replacement.loadAddon).not.toHaveBeenCalled();
});

test("async terminal readiness and multiple panes never load the corrupting WebGL addon", () => {
  const terminals = [terminalStub(), terminalStub(), terminalStub()];
  const panes = (ready: boolean) => terminals.map((terminal, index) => (
    <WebglHarness key={index} terminal={terminal} sessionId={`pane-${index}`}
      active={index !== 1} allowTransparency={index === 2} ready={ready} />
  ));
  const view = render(
    <>{panes(false)}</>,
  );
  expect(webglInstances).toHaveLength(0);
  view.rerender(<>{panes(true)}</>);
  expect(webglInstances).toHaveLength(0);
  for (const terminal of terminals) expect(terminal.loadAddon).not.toHaveBeenCalled();
  view.unmount();
});
