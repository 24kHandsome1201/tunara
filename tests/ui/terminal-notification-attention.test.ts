import { afterEach, expect, test } from "vitest";
import { emitTerminalNotification } from "@/ui/terminal-attention";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import type { Session } from "@/ui/types";

const shell: Session = { id: "herdr", title: "work: herdr", dir: "/tmp", branch: "", runState: "running", updatedAt: 1 };
const other: Session = { ...shell, id: "other", title: "Other" };

afterEach(() => {
  useSessionsStore.setState({ sessions: [], activeSessionId: null });
  useUIStore.setState({ toasts: [] });
});

test("background non-Agent sessions surface OSC notifications once", () => {
  useSessionsStore.setState({ sessions: [shell, other], activeSessionId: other.id });
  useUIStore.setState({ toasts: [] });
  emitTerminalNotification(shell.id, { title: "claude needs input", body: "pane 2" });
  emitTerminalNotification(shell.id, { title: "claude needs input", body: "pane 2" });
  const toasts = useUIStore.getState().toasts;
  expect(toasts).toHaveLength(1);
  expect(toasts[0]).toMatchObject({ sessionId: shell.id, title: "claude needs input", subtitle: "pane 2" });
});

test("Agent sessions keep the confirmation path only", () => {
  useSessionsStore.setState({ sessions: [{ ...shell, id: "agent", agent: "CC" }, other], activeSessionId: other.id });
  useUIStore.setState({ toasts: [] });
  emitTerminalNotification("agent", { title: "done" });
  expect(useUIStore.getState().toasts).toHaveLength(0);
});
