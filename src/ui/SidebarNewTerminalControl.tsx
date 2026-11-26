import { useT } from "@/modules/i18n";
import { useUIStore } from "@/state/ui";
import { useState } from "react";
import { ContextMenu, type MenuEntry } from "./ContextMenu";
import { Tooltip } from "./Tooltip";
import { CaretDown, Icon, Plus } from "@/ui/icons";

interface SidebarNewTerminalControlProps {
  onNewTerminal: () => void;
  onNewTerminalInDirectory?: () => void;
}

export function SidebarNewTerminalControl({
  onNewTerminal,
  onNewTerminalInDirectory,
}: SidebarNewTerminalControlProps) {
  const t = useT();
  const [menu, setMenu] = useState<{ items: MenuEntry[]; position: { x: number; y: number } } | null>(null);

  const openNewMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({
      position: { x: rect.right, y: rect.bottom },
      items: [
        ...(onNewTerminalInDirectory
          ? [{ id: "new-terminal-directory", label: t("titlebar.new_terminal_in_directory"), icon: "folder" as const, action: onNewTerminalInDirectory }]
          : []),
        null,
        { id: "new-ssh-session", label: t("titlebar.new_ssh_session"), icon: "ssh", action: () => useUIStore.getState().openSshConnect() },
      ],
    });
  };

  return (
    <>
      <div className="sidebar-new-terminal">
        <div>
          <Tooltip label={t("common.new_terminal")} style={{ flex: 1, minWidth: 0 }}>
          <button
            type="button"
            onClick={onNewTerminal}
          >
            <Icon icon={Plus} size={12} weight="bold" />
            <span className="sidebar-new-terminal-label">{t("common.new_terminal")}</span>
          </button>
          </Tooltip>
          <Tooltip label={t("sidebar.new_menu")}>
          <button
            type="button"
            onClick={openNewMenu}
            aria-label={t("sidebar.new_menu")}
            aria-haspopup="menu"
            aria-expanded={Boolean(menu)}
          >
            <Icon icon={CaretDown} size={10} weight="bold" />
          </button>
          </Tooltip>
        </div>
      </div>
      {menu && <ContextMenu items={menu.items} position={menu.position} onClose={() => setMenu(null)} />}
    </>
  );
}
