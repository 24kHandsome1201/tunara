import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import {
  isDestructiveConfirmPending,
  requestDestructiveConfirm,
  useDestructiveConfirm,
} from "@/ui/lib/destructive-confirm";

describe("requestDestructiveConfirm", () => {
  test("notifies on arm so pending state re-renders", () => {
    const store = new Map<string, number>();
    const onChange = vi.fn();
    expect(requestDestructiveConfirm(store, "key", onChange)).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(isDestructiveConfirmPending(store, "key")).toBe(true);
  });

  test("notifies on confirm and runs the action", () => {
    const store = new Map<string, number>();
    const onChange = vi.fn();
    requestDestructiveConfirm(store, "key", onChange);
    expect(requestDestructiveConfirm(store, "key", onChange)).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(isDestructiveConfirmPending(store, "key")).toBe(false);
  });
});

describe("useDestructiveConfirm", () => {
  function Probe({ onConfirm }: { onConfirm: () => void }) {
    const { isPending, tryConfirm } = useDestructiveConfirm();
    return (
      <button
        type="button"
        data-pending={isPending("item") ? "true" : "false"}
        onClick={() => tryConfirm("item", onConfirm)}
      />
    );
  }

  test("first click renders pending state; second click runs the action", () => {
    const onConfirm = vi.fn();
    render(<Probe onConfirm={onConfirm} />);
    const button = screen.getByRole("button");
    expect(button.dataset.pending).toBe("false");

    fireEvent.click(button);
    expect(button.dataset.pending).toBe("true");
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(button);
    expect(button.dataset.pending).toBe("false");
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test("pending state clears after the confirm window expires", () => {
    vi.useFakeTimers();
    try {
      const onConfirm = vi.fn();
      render(<Probe onConfirm={onConfirm} />);
      const button = screen.getByRole("button");

      fireEvent.click(button);
      expect(button.dataset.pending).toBe("true");

      act(() => {
        vi.advanceTimersByTime(3_100);
      });
      expect(button.dataset.pending).toBe("false");
      expect(onConfirm).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
