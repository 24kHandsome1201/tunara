import { afterEach, expect, test, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { createInputQueueFullWarner } from "@/ui/terminal-attention";

afterEach(() => vi.useRealTimers());

test("input queue warnings notify snapshots only after xterm parses the notice", () => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  let parsed: (() => void) | undefined;
  const write = vi.fn((_text: string, callback?: () => void) => { parsed = callback; });
  const onWritten = vi.fn();
  const warn = createInputQueueFullWarner({ write } as unknown as Terminal, onWritten);

  warn(undefined);
  warn(new Error("ssh session closed"));
  expect(write).not.toHaveBeenCalled();
  warn(new Error("ssh input queue full"));
  expect(write).toHaveBeenCalledTimes(1);
  expect(onWritten).not.toHaveBeenCalled();
  parsed?.();
  expect(onWritten).toHaveBeenCalledTimes(1);
  warn(new Error("ssh input queue full"));
  expect(write).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(2001);
  warn(new Error("ssh input queue full"));
  expect(write).toHaveBeenCalledTimes(2);
});
