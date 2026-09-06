import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { setLanguage } from "@/modules/i18n";
import { createSession, useSessionsStore } from "@/state/sessions";
import { SessionCard } from "@/ui/SessionCard";
import { SidebarNewTerminalControl } from "@/ui/SidebarNewTerminalControl";
import { deriveTitle, type Session } from "@/ui/types";

function session(patch: Partial<Session> = {}): Session {
  return {
    id: "one",
    title: "Terminal 1",
    dir: "/work/project",
    branch: "main",
    runState: "idle",
    updatedAt: 1,
    ...patch,
  };
}

beforeEach(() => {
  setLanguage("en");
  useSessionsStore.setState({ sessions: [], activeSessionId: null, recentDirs: [] });
});

describe("independent sidebar workflow", () => {
  test("title identity ignores command, shell title, and agent activity", () => {
    const changing = session({
      agent: "CC",
      agentActivity: "running",
      lastCommand: "pnpm test",
      shellTitle: "tests",
    });
    expect(deriveTitle(changing).primary).toBe("Terminal 1");
    expect(deriveTitle({ ...changing, customTitle: "Release" }).primary).toBe("Release");
  });

  test("store assigns stable numbers within a project regardless of agent", () => {
    const first = createSession("/work/project", { agent: "CC" });
    const second = createSession("/work/project", { agent: "CC" });
    const otherAgent = createSession("/work/project", { agent: "CX" });
    useSessionsStore.getState().addSession(first);
    useSessionsStore.getState().addSession(second);
    useSessionsStore.getState().addSession(otherAgent);

    expect(useSessionsStore.getState().sessions.map((entry) => entry.title)).toEqual([
      "Terminal 1",
      "Terminal 2",
      "Terminal 3",
    ]);
  });

  test("Enter selects a card while F2 still renames it", () => {
    const onSelect = vi.fn();
    render(<SessionCard session={session()} active onSelect={onSelect} onRename={vi.fn()} />);
    const card = screen.getByRole("button", { name: /Terminal 1/ });
    fireEvent.keyDown(card, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("one");
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.keyDown(card, { key: "F2" });
    expect(screen.getByRole("textbox")).toBeTruthy();
  });

  test("new terminal is the primary action and the arrow owns folder and SSH", () => {
    const onNewTerminal = vi.fn();
    const onDirectory = vi.fn();
    render(<SidebarNewTerminalControl onNewTerminal={onNewTerminal} onNewTerminalInDirectory={onDirectory} />);

    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    expect(onNewTerminal).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "New session menu" }));
    const menu = screen.getByRole("menu");
    expect(within(menu).queryByRole("menuitem", { name: "New terminal" })).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "New terminal in folder…" })).toBeTruthy();
    expect(within(menu).getByRole("menuitem", { name: "New SSH connection…" })).toBeTruthy();
  });
});
