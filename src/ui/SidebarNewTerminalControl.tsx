import { formatShortcut } from "./formatShortcut";
import { useT } from "@/modules/i18n";
import { useUIStore } from "@/state/ui";

interface SidebarNewTerminalControlProps {
  onNewTerminal: () => void;
  onNewTerminalInDirectory?: () => void;
}

export function SidebarNewTerminalControl({
  onNewTerminal,
  onNewTerminalInDirectory,
}: SidebarNewTerminalControlProps) {
  const t = useT();
  const shortcut = useUIStore((state) => state.keybindings.newTerminal);

  return (
    <div style={{ padding: "8px 12px 6px" }}>
      <div
        style={{
          width: "100%",
          height: "var(--h-btn-md)",
          border: "1px solid var(--c-border-2)",
          borderRadius: "var(--r-btn)",
          background: "var(--c-bg-white)",
          display: "flex",
          alignItems: "center",
          overflow: "hidden",
        }}
      >
        <button
          onClick={onNewTerminal}
          className="hover-accent-bg"
          style={{
            height: "100%",
            minWidth: 0,
            flex: 1,
            padding: "0 8px 0 10px",
            border: "none",
            background: "transparent",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 6,
            transition: "background var(--duration-fast) var(--ease-smooth)",
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--c-accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          <span style={{ fontSize: "var(--fs-secondary)", fontWeight: 600, color: "var(--c-accent)", lineHeight: 1 }}>
            {t("sidebar.new_terminal")}
          </span>
          <span
            style={{
              marginLeft: "auto",
              height: 18,
              display: "inline-flex",
              alignItems: "center",
              fontSize: "var(--fs-meta)",
              color: "var(--c-text-5)",
              fontFamily: "var(--font-mono)",
              background: "var(--c-bg-2)",
              borderRadius: "var(--r-badge)",
              padding: "0 6px",
              flexShrink: 0,
            }}
          >
            {formatShortcut(shortcut)}
          </span>
        </button>
        {onNewTerminalInDirectory && (
          <button
            onClick={onNewTerminalInDirectory}
            title={t("sidebar.new_terminal_in_directory")}
            aria-label={t("sidebar.new_terminal_in_directory")}
            className="hover-accent-bg"
            style={{
              width: 32,
              height: "100%",
              padding: 0,
              border: "none",
              borderLeft: "1px solid var(--c-border-2)",
              background: "transparent",
              color: "var(--c-accent)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
              transition: "background var(--duration-fast) var(--ease-smooth)",
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6.5h6l2 2h10v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
              <path d="M3 9h18" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
