import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Tooltip } from "@/ui/Tooltip";

describe("Tooltip", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("shows after the delay on hover and wires aria-describedby only while visible", () => {
    render(
      <Tooltip label="New terminal">
        <button type="button" aria-label="New terminal" />
      </Tooltip>,
    );
    const trigger = screen.getByRole("button");
    expect(trigger.getAttribute("aria-describedby")).toBeNull();

    fireEvent.mouseEnter(trigger);
    expect(screen.queryByRole("tooltip")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(500);
    });
    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).toContain("New terminal");
    expect(trigger.getAttribute("aria-describedby")).toBe(tip.id);

    fireEvent.mouseLeave(trigger);
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(trigger.getAttribute("aria-describedby")).toBeNull();
  });

  test("shows on keyboard focus and hides on Escape", () => {
    render(
      <Tooltip label="Toggle sidebar" shortcut="mod+b">
        <button type="button" aria-label="Toggle sidebar" />
      </Tooltip>,
    );
    const trigger = screen.getByRole("button");
    fireEvent.focus(trigger);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).toContain("Toggle sidebar");
    expect(tip.querySelector("kbd")).not.toBeNull();

    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  test("renders the bubble in document.body so transformed ancestors cannot reposition it", () => {
    const { container } = render(
      <div style={{ transform: "translateY(-1px)" }}>
        <Tooltip label="Menu">
          <button type="button" aria-label="Menu" />
        </Tooltip>
      </div>,
    );
    fireEvent.mouseEnter(screen.getByRole("button"));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    const tip = screen.getByRole("tooltip");
    // A transform on an ancestor makes it the containing block for
    // position:fixed — the bubble must live outside that subtree.
    const transformedAncestor = container.firstElementChild as HTMLElement;
    expect(transformedAncestor.contains(tip)).toBe(false);
    expect(document.body.contains(tip)).toBe(true);
    expect(tip.parentElement).toBe(document.body);
  });
});
