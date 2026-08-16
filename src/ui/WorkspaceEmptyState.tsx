import type { CSSProperties } from "react";
import { useSessionsStore } from "@/state/sessions";
import { useT } from "@/modules/i18n";
import { collectRecentTerminalDirs } from "@/ui/overlays/command-palette-recents";

interface WorkspaceEmptyStateProps {
  onNewTerminal: () => void;
  onNewTerminalInDirectory: () => void;
  onOpenSsh: () => void;
}

const secondaryButtonStyle: CSSProperties = {
  padding: "7px 14px",
  borderRadius: "var(--r-btn)",
  border: "1px solid var(--c-border-2)",
  background: "var(--c-bg-white)",
  color: "var(--c-text-2)",
  fontSize: "var(--fs-body)",
  fontWeight: 600,
  cursor: "pointer",
};

export function WorkspaceEmptyState({
  onNewTerminal,
  onNewTerminalInDirectory,
  onOpenSsh,
}: WorkspaceEmptyStateProps) {
  const t = useT();
  const recentDirs = useSessionsStore((s) => s.recentDirs);
  const recents = collectRecentTerminalDirs(recentDirs, undefined, 5);

  return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", minWidth: 0 }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, maxWidth: 420, padding: 16 }}>
        <div style={{ width: 64, height: 64, borderRadius: "var(--r-overlay)", background: "var(--c-bg-3)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--c-text-4)" }}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
        </div>
        <span style={{ fontSize: "var(--fs-title)", fontWeight: 700, color: "var(--c-text-primary)" }}>{t("app.empty.title")}</span>
        <span style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-5)", textAlign: "center" }}>{t("app.empty.hint")}</span>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
          <button
            type="button"
            onClick={onNewTerminalInDirectory}
            className="hover-primary"
            style={{ padding: "8px 18px", borderRadius: "var(--r-btn)", border: "none", background: "var(--c-btn-primary-bg)", color: "var(--c-btn-primary-text)", fontSize: "var(--fs-body)", fontWeight: 600, cursor: "pointer" }}
          >
            {t("sidebar.new_terminal_in_directory")}
          </button>
          <button type="button" onClick={onNewTerminal} className="hover-bg" style={secondaryButtonStyle}>
            {t("sidebar.new_terminal")}
          </button>
          <button type="button" onClick={onOpenSsh} className="hover-bg" style={secondaryButtonStyle}>
            {t("sidebar.new_ssh_connection")}
          </button>
        </div>
        {recents.length > 0 && (
          <div style={{ width: "100%", marginTop: 4 }}>
            <div style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", letterSpacing: "0.04em", textTransform: "uppercase", textAlign: "center", marginBottom: 8 }}>
              {t("app.empty.recent")}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {recents.map((entry) => (
                <button
                  key={entry.dir}
                  type="button"
                  className="hover-bg"
                  title={entry.dir}
                  onClick={() => useSessionsStore.getState().newTerminalInDir(entry.dir)}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    border: "none",
                    background: "transparent",
                    color: "var(--c-text-2)",
                    fontSize: "var(--fs-secondary)",
                    fontFamily: "var(--font-ui)",
                    padding: "7px 10px",
                    borderRadius: "var(--r-btn)",
                    cursor: "pointer",
                  }}
                >
                  <span style={{ fontWeight: 600 }}>{entry.label}</span>
                  <span style={{ display: "block", fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {entry.dir}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
