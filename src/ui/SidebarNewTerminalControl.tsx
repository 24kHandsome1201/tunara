import { useT } from "@/modules/i18n";
import { useUIStore } from "@/state/ui";
import { useState } from "react";
import { ContextMenu, type MenuEntry } from "./ContextMenu";

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
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          <span>{t("sidebar.new_compact")}</span>
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ marginLeft: "auto" }}>
            <path d="m3 4.5 3 3 3-3" />
          </svg>
        </button>
      </div>
      {menu && <ContextMenu items={menu.items} position={menu.position} onClose={() => setMenu(null)} />}
    </>
  );
}
