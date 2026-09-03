import { useT } from "@/modules/i18n";
import { useUIStore } from "@/state/ui";
import { useState } from "react";
import { ContextMenu, type MenuEntry } from "./ContextMenu";
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
        { id: "new-terminal", label: t("sidebar.new_terminal"), icon: "terminal", action: onNewTerminal },
        ...(onNewTerminalInDirectory
          ? [{ id: "new-terminal-directory", label: t("sidebar.new_terminal_in_directory"), icon: "folder" as const, action: onNewTerminalInDirectory }]
          : []),
        null,
        { id: "new-ssh", label: t("sidebar.new_ssh_connection"), icon: "ssh", action: () => useUIStore.getState().openSshConnect() },
      ],
    });
  };

  return (
    <>
      <div style={{ padding: "8px 12px 6px" }}>
        <button
          type="button"
          onClick={openNewMenu}
          title={t("sidebar.new_menu")}
          aria-label={t("sidebar.new_menu")}
          aria-haspopup="menu"
          aria-expanded={Boolean(menu)}
          className="hover-bg"
          style={{
            width: "100%",
            height: 30,
            padding: "0 9px",
            border: "1px solid var(--c-control-border)",
            borderRadius: "var(--r-btn)",
            background: "var(--c-bg-white)",
            color: "var(--c-text-2)",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 7,
            fontFamily: "var(--font-ui)",
            fontSize: "var(--fs-secondary)",
            fontWeight: 600,
          }}
        >
          <Icon icon={Plus} size={12} weight="bold" />
          <span>{t("sidebar.new_compact")}</span>
          <Icon icon={CaretDown} size={10} weight="bold" style={{ marginLeft: "auto" }} />
        </button>
      </div>
      {menu && <ContextMenu items={menu.items} position={menu.position} onClose={() => setMenu(null)} />}
    </>
  );
}
