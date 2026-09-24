import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { splitLayoutSessionIds } from "@/modules/session/split-layout";
import { TerminalExitBanner } from "@/ui/TerminalExitBanner";
import type { Session } from "@/ui/types";

const base: Session = { id: "live", title: "Live", dir: "/tmp/live", branch: "", runState: "idle", updatedAt: 1 };

test("restarting an inactive dead pane replaces that pane, not the active one", () => {
  const live = base;
  const dead: Session = { ...base, id: "dead", title: "Dead", dir: "/tmp/dead", runState: "failed" };
  useSessionsStore.setState({ sessions: [live, dead], activeSessionId: live.id });
  useUIStore.setState({ split: { root: null } });
  useUIStore.getState().splitPane(live.id, dead.id, "horizontal");

  render(<TerminalExitBanner session={dead} exitCode={1} />);
  fireEvent.click(screen.getByRole("button", { name: "Restart in this directory" }));

  const sessions = useSessionsStore.getState().sessions;
  expect(sessions.some((session) => session.id === dead.id)).toBe(false);
  const replacement = sessions.find((session) => session.id !== live.id);
  expect(replacement?.dir).toBe("/tmp/dead");
  expect(splitLayoutSessionIds(useUIStore.getState().split)).toEqual([live.id, replacement!.id]);
});

test("closing a session that took over a split pane brings the displaced session back", () => {
  const left: Session = { ...base, id: "left", title: "Left", dir: "/tmp/left" };
  const right: Session = { ...base, id: "right", title: "Right", dir: "/tmp/right" };
  useSessionsStore.setState({ sessions: [left, right], activeSessionId: left.id });
  useUIStore.setState({ split: { root: null } });
  useUIStore.getState().splitPane(left.id, right.id, "horizontal");

  const newcomer: Session = { ...base, id: "ssh", title: "SSH", dir: "~" };
  useSessionsStore.getState().addSession(newcomer);
  expect(splitLayoutSessionIds(useUIStore.getState().split)).toEqual([newcomer.id, right.id]);

  useSessionsStore.getState().removeSession(newcomer.id);
  expect(splitLayoutSessionIds(useUIStore.getState().split)).toEqual([left.id, right.id]);
  expect(useSessionsStore.getState().activeSessionId).toBe(left.id);
});

test("a displaced session that was closed meanwhile is not resurrected", () => {
  const left: Session = { ...base, id: "left2", title: "Left", dir: "/tmp/left" };
  const right: Session = { ...base, id: "right2", title: "Right", dir: "/tmp/right" };
  useSessionsStore.setState({ sessions: [left, right], activeSessionId: left.id });
  useUIStore.setState({ split: { root: null } });
  useUIStore.getState().splitPane(left.id, right.id, "horizontal");
  const newcomer: Session = { ...base, id: "ssh2", title: "SSH", dir: "~" };
  useSessionsStore.getState().addSession(newcomer);

  useSessionsStore.getState().removeSession(left.id);
  useSessionsStore.getState().removeSession(newcomer.id);
  expect(splitLayoutSessionIds(useUIStore.getState().split)).not.toContain(left.id);
  expect(useSessionsStore.getState().sessions.some((session) => session.id === left.id)).toBe(false);
});
