import { useRef, useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { Modal, useModalBehavior, type ModalCloseReason } from "@/ui/overlays/Modal";
import { useContextMenuTrigger } from "@/ui/overlays/context-menu-trigger";
import {
  INSPECTOR_TAB_DESCRIPTORS,
  InspectorScopeEpoch,
  resolveInspectorScope,
} from "@/ui/inspector-scope";
import type { Session } from "@/ui/types";
import { PanelEmptyState, PanelIconButton } from "@/ui/shared";

function ModalHarness({ binding = "one", currentBinding = "one", onClose }: {
  binding?: string;
  currentBinding?: string;
  onClose: (reason: ModalCloseReason) => void;
}) {
  const [open, setOpen] = useState(true);
  const safeRef = useRef<HTMLButtonElement>(null);
  return <>
    <button type="button">Opener</button>
    {open && <Modal
      labelledBy="modal-title"
      onRequestClose={(reason) => { onClose(reason); setOpen(false); }}
      initialFocus={safeRef}
      bindingKey={binding}
      currentBindingKey={currentBinding}
    >
      <h2 id="modal-title">Safe action</h2>
      <button type="button">Destructive</button>
      <button type="button" ref={safeRef}>Cancel</button>
    </Modal>}
  </>;
}

test("modal uses safe initial focus, traps both Tab directions, handles Escape, and returns focus", () => {
  const onClose = vi.fn();
  const opener = document.createElement("button");
  opener.textContent = "External opener";
  document.body.appendChild(opener);
  opener.focus();
  render(<ModalHarness onClose={onClose} />);

  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.keyDown(document, { key: "Tab" });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Destructive" }));
  fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).toHaveBeenCalledWith("escape");
  expect(document.activeElement).toBe(opener);
  opener.remove();
});

test("modal closes when its transport binding becomes stale and keeps narrow actions scrollable", () => {
  const onClose = vi.fn();
  const view = render(<ModalHarness onClose={onClose} />);
  const dialog = screen.getByRole("dialog");
  expect(dialog.style.maxWidth).toBe("calc(100vw - 24px)");
  expect(dialog.style.maxHeight).toBe("calc(100dvh - 24px)");
  expect(dialog.style.overflow).toBe("auto");

  view.rerender(<ModalHarness binding="one" currentBinding="two" onClose={onClose} />);
  expect(onClose).toHaveBeenCalledWith("stale-binding");
});

function LongPressHarness({ onOpen, onClick = () => {} }: { onOpen: (x: number, y: number) => void; onClick?: () => void }) {
  const trigger = useContextMenuTrigger<HTMLButtonElement>({
    onOpen: ({ x, y }) => onOpen(x, y),
    longPressMs: 500,
  });
  return <div><button type="button" onClick={onClick} {...trigger}>Actions</button></div>;
}

test("touch long-press opens once while movement cancels it", () => {
  vi.useFakeTimers();
  const onOpen = vi.fn();
  const onClick = vi.fn();
  render(<LongPressHarness onOpen={onOpen} onClick={onClick} />);
  const trigger = screen.getByRole("button", { name: "Actions" });

  fireEvent.pointerDown(trigger, { pointerType: "touch", isPrimary: true, clientX: 20, clientY: 30 });
  act(() => vi.advanceTimersByTime(500));
  expect(onOpen).toHaveBeenCalledWith(20, 30);
  fireEvent.pointerUp(trigger, { pointerType: "touch" });
  fireEvent.click(trigger);
  expect(onClick).not.toHaveBeenCalled();

  fireEvent.pointerDown(trigger, { pointerType: "touch", isPrimary: true, clientX: 20, clientY: 30 });
  fireEvent.pointerMove(trigger, { pointerType: "touch", clientX: 50, clientY: 30 });
  act(() => vi.advanceTimersByTime(500));
  expect(onOpen).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
});

function StackedModals() {
  const [bottomOpen, setBottomOpen] = useState(true);
  const [topOpen, setTopOpen] = useState(true);
  return <>
    {bottomOpen && <Modal labelledBy="bottom-title" onRequestClose={() => setBottomOpen(false)}>
      <h2 id="bottom-title">Bottom</h2><button type="button">Bottom action</button>
    </Modal>}
    {topOpen && <Modal labelledBy="top-title" onRequestClose={() => setTopOpen(false)}>
      <h2 id="top-title">Top</h2><button type="button">Top action</button>
    </Modal>}
  </>;
}

test("only the top modal handles Escape and focus returns to the underlying modal", () => {
  render(<StackedModals />);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Top action" }));
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("dialog", { name: "Top" })).toBeNull();
  expect(screen.getByRole("dialog", { name: "Bottom" })).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Bottom action" }));
});

test("scope descriptors cover every Inspector tab and stale async tickets are rejected", () => {
  const ids = Object.keys(INSPECTOR_TAB_DESCRIPTORS);
  expect(ids).toHaveLength(5);
  expect(INSPECTOR_TAB_DESCRIPTORS.preview.scope).toBe("logical-session");
  expect(INSPECTOR_TAB_DESCRIPTORS.forwarding.scope).toBe("transport-binding");

  const session: Session = {
    id: "logical-one",
    title: "Scope",
    dir: "/tmp",
    branch: "main",
    runState: "idle",
    updatedAt: 1,
  };
  const first = resolveInspectorScope(INSPECTOR_TAB_DESCRIPTORS.files, session, {
    logicalSessionId: session.id,
    physicalPtyId: 4,
    transportGeneration: "first",
  });
  const epoch = new InspectorScopeEpoch(first.key);
  const staleTicket = epoch.capture();
  const second = resolveInspectorScope(INSPECTOR_TAB_DESCRIPTORS.files, session, {
    logicalSessionId: session.id,
    physicalPtyId: 8,
    transportGeneration: "second",
  });
  epoch.switchScope(second.key);

  expect(first.kind).toBe("transport-binding");
  expect(epoch.isCurrent(staleTicket)).toBe(false);
  expect(epoch.isCurrent(epoch.capture())).toBe(true);
});

function BehaviorHarness() {
  const ref = useRef<HTMLDivElement>(null);
  useModalBehavior(ref, { initialFocus: "container" });
  return <div ref={ref} tabIndex={-1} role="dialog" aria-label="No controls" />;
}

test("a modal with no controls keeps focus on its dialog container", () => {
  render(<BehaviorHarness />);
  expect(document.activeElement).toBe(screen.getByRole("dialog", { name: "No controls" }));
});

test("panel primitives keep empty states compact and icon actions keyboard reachable", () => {
  render(<>
    <PanelEmptyState label="Nothing here" sublabel="Choose another directory" />
    <PanelIconButton aria-label="Refresh panel">↻</PanelIconButton>
  </>);

  expect(screen.getByRole("status").getAttribute("data-density")).toBe("compact");
  expect(screen.getByText("Choose another directory")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Refresh panel" }).getAttribute("type")).toBe("button");
});
