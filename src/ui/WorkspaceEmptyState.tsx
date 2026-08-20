import type { CSSProperties } from "react";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { useT } from "@/modules/i18n";
import { collectRecentTerminalDirs } from "@/ui/overlays/command-palette-recents";
import { formatShortcut } from "./formatShortcut";

interface WorkspaceEmptyStateProps {
  onNewTerminal: () => void;
  onNewTerminalInDirectory: () => void;
  onOpenSsh: () => void;
}

const secondaryActionStyle: CSSProperties = {
  minWidth: 0,
  flex: "1 1 190px",
  minHeight: 58,
  padding: "10px 12px",
  borderRadius: "var(--r-btn)",
  border: "1px solid var(--c-border-2)",
  background: "var(--c-bg-white)",
  color: "var(--c-text-2)",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  gap: 10,
  textAlign: "left",
};

const shortcutStyle: CSSProperties = {
  marginLeft: "auto",
  height: 20,
  display: "inline-flex",
  alignItems: "center",
  padding: "0 6px",
  borderRadius: "var(--r-badge)",
  background: "var(--c-bg-2)",
  color: "var(--c-text-5)",
  fontFamily: "var(--font-mono)",
  fontSize: "var(--fs-meta)",
  flexShrink: 0,
};

function FolderPlusIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6.5h6l2 2h10v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      <path d="M3 9h18" />
      <path d="M12 12v5" />
      <path d="M9.5 14.5h5" />
    </svg>
  );
}

function TerminalIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function SshIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <polyline points="7 9 10 12 7 15" />
      <line x1="12" y1="15" x2="16" y2="15" />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="9 6 15 12 9 18" />
    </svg>
  );
}

export function WorkspaceEmptyState({
  onNewTerminal,
  onNewTerminalInDirectory,
  onOpenSsh,
}: WorkspaceEmptyStateProps) {
  const t = useT();
  const recentDirs = useSessionsStore((s) => s.recentDirs);
  const newTerminalShortcut = useUIStore((s) => s.keybindings.newTerminal);
  const recents = collectRecentTerminalDirs(recentDirs, undefined, 5);

  return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", minWidth: 0, minHeight: 0, padding: 24 }}>
      <section
        aria-labelledby="workspace-empty-title"
        style={{
          width: "100%",
          maxWidth: 520,
          padding: 22,
          borderRadius: "var(--r-overlay)",
          border: "1px solid var(--c-border-1)",
          background: "var(--c-bg-1)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ width: 52, height: 52, borderRadius: "var(--r-card)", background: "var(--c-bg-3)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--c-text-4)", flexShrink: 0 }}>
            <TerminalIcon />
          </div>
          <div style={{ minWidth: 0 }}>
            <h1 id="workspace-empty-title" style={{ margin: 0, fontSize: "var(--fs-title)", lineHeight: 1.3, fontWeight: 700, color: "var(--c-text-primary)" }}>
              {t("app.empty.title")}
            </h1>
            <p style={{ margin: "4px 0 0", fontSize: "var(--fs-secondary)", lineHeight: 1.45, color: "var(--c-text-5)" }}>
              {t("app.empty.hint")}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={onNewTerminalInDirectory}
          className="hover-primary"
          style={{
            width: "100%",
            marginTop: 18,
            minHeight: 58,
            padding: "10px 12px",
            borderRadius: "var(--r-btn)",
            border: "none",
            background: "var(--c-btn-primary-bg)",
            color: "var(--c-btn-primary-text)",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: 10,
            textAlign: "left",
          }}
        >
          <span style={{ width: 34, height: 34, borderRadius: "var(--r-badge)", display: "grid", placeItems: "center", background: "color-mix(in srgb, currentColor 12%, transparent)", flexShrink: 0 }}>
            <FolderPlusIcon />
          </span>
          <span style={{ minWidth: 0, flex: 1, fontSize: "var(--fs-body)", fontWeight: 700 }}>
            {t("sidebar.new_terminal_in_directory")}
          </span>
          <span style={{ display: "flex", color: "currentColor", opacity: 0.78, flexShrink: 0 }}>
            <ArrowIcon />
          </span>
        </button>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 }}>
          <button type="button" onClick={onNewTerminal} className="hover-bg" style={secondaryActionStyle}>
            <span style={{ width: 32, height: 32, borderRadius: "var(--r-badge)", display: "grid", placeItems: "center", background: "var(--c-bg-3)", color: "var(--c-text-4)", flexShrink: 0 }}>
              <TerminalIcon />
            </span>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: "block", fontSize: "var(--fs-secondary)", fontWeight: 650, color: "var(--c-text-2)" }}>
                {t("sidebar.new_terminal")}
              </span>
              <span style={{ display: "block", marginTop: 2, fontSize: "var(--fs-meta)", fontFamily: "var(--font-mono)", color: "var(--c-text-5)" }}>~</span>
            </span>
            {newTerminalShortcut && <span style={shortcutStyle}>{formatShortcut(newTerminalShortcut)}</span>}
          </button>

          <button type="button" onClick={onOpenSsh} className="hover-bg" style={secondaryActionStyle}>
            <span style={{ width: 32, height: 32, borderRadius: "var(--r-badge)", display: "grid", placeItems: "center", background: "var(--c-bg-3)", color: "var(--c-text-4)", flexShrink: 0 }}>
              <SshIcon />
            </span>
            <span style={{ minWidth: 0, flex: 1 }}>
              <span style={{ display: "block", fontSize: "var(--fs-secondary)", fontWeight: 650, color: "var(--c-text-2)" }}>
                {t("sidebar.new_ssh_connection")}
              </span>
              <span style={{ display: "block", marginTop: 2, fontSize: "var(--fs-meta)", fontFamily: "var(--font-mono)", color: "var(--c-text-5)" }}>SSH</span>
            </span>
            <span style={{ display: "flex", color: "var(--c-text-5)", flexShrink: 0 }}>
              <ArrowIcon />
            </span>
          </button>
        </div>

        {recents.length > 0 && (
          <section aria-labelledby="workspace-recent-title" style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--c-border-2)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 7 }}>
              <h2 id="workspace-recent-title" style={{ margin: 0, fontSize: "var(--fs-meta)", lineHeight: "18px", fontWeight: 700, color: "var(--c-text-4)", letterSpacing: "0.04em", textTransform: "uppercase" }}>
                {t("app.empty.recent")}
              </h2>
              <span style={{ minWidth: 20, height: 18, display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "0 5px", borderRadius: "var(--r-pill)", background: "var(--c-bg-3)", color: "var(--c-text-5)", fontSize: "var(--fs-meta)", fontFamily: "var(--font-mono)" }}>
                {recents.length}
              </span>
            </div>
            <div role="list" style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {recents.map((entry) => (
                <div role="listitem" key={entry.dir}>
                  <button
                    type="button"
                    className="hover-bg"
                    title={entry.dir}
                    aria-label={`${entry.label}, ${entry.dir}`}
                    onClick={() => useSessionsStore.getState().newTerminalInDir(entry.dir)}
                    style={{
                      width: "100%",
                      minHeight: 46,
                      textAlign: "left",
                      border: "none",
                      background: "transparent",
                      color: "var(--c-text-2)",
                      padding: "6px 8px",
                      borderRadius: "var(--r-btn)",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: 9,
                    }}
                  >
                    <span style={{ width: 28, height: 28, borderRadius: "var(--r-badge)", display: "grid", placeItems: "center", background: "var(--c-bg-3)", color: "var(--c-text-5)", flexShrink: 0 }}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M3 6.5h6l2 2h10v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
                        <path d="M3 9h18" />
                      </svg>
                    </span>
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: "block", fontSize: "var(--fs-secondary)", fontWeight: 650, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {entry.label}
                      </span>
                      <span style={{ display: "block", marginTop: 1, fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {entry.dir}
                      </span>
                    </span>
                    <span style={{ display: "flex", color: "var(--c-text-5)", flexShrink: 0 }}>
                      <ArrowIcon />
                    </span>
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}
      </section>
    </div>
  );
}
