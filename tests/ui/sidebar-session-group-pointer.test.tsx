import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";

import { setLanguage } from "@/modules/i18n";
import { groupSessionsForSidebar } from "@/modules/session/sidebar-groups";
import { useSessionsStore } from "@/state/sessions";
import { SidebarSessionGroup } from "@/ui/SidebarSessionGroup";
import type { Session } from "@/ui/types";

const session: Session = {
  id: "one",
  title: "Terminal 1",
  dir: "/work/project",
  branch: "main",
  runState: "idle",
  updatedAt: 1,
};

beforeEach(() => {
  setLanguage("en");
  useSessionsStore.setState({ sessions: [session], activeSessionId: session.id });
});

function renderGroup() {
  const onDragStart = vi.fn();
  const onContextMenu = vi.fn((event: React.MouseEvent) => event.preventDefault());
  const [group] = groupSessionsForSidebar([session]);
  render(
    <SidebarSessionGroup
      group={group}
      collapsed={false}
      activeSessionId={session.id}
      tabbableSessionId={session.id}
      canReorder
      drag={null}
      confirmCloseAt={0}
      closeConfirmations={{}}
      externalEditor="vscode"
      t={(key) => key}
      onToggleCollapse={() => {}}
      onOpenMenu={() => {}}
      onDragStart={onDragStart}
      onSelect={() => {}}
      onKeyDown={() => {}}
      onClose={() => {}}
      onRename={() => {}}
      onContextMenu={onContextMenu}
    />,
  );
  return { onDragStart, onContextMenu };
}

test("only the primary button arms session reordering so right-click reaches the context menu", () => {
  const { onDragStart, onContextMenu } = renderGroup();
  const card = screen.getByText("Terminal 1");

  fireEvent.pointerDown(card, { button: 2, pointerType: "mouse", pointerId: 1 });
  expect(onDragStart).not.toHaveBeenCalled();

  fireEvent.contextMenu(card);
  expect(onContextMenu).toHaveBeenCalledTimes(1);

  fireEvent.pointerDown(card, { button: 0, pointerType: "mouse", pointerId: 1 });
  expect(onDragStart).toHaveBeenCalledTimes(1);
});
