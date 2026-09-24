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
