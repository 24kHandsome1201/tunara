import type { CSSProperties } from "react";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { useT } from "@/modules/i18n";
import { hostProfileButtonLabel, sshConnectPrefillFromProfile } from "@/modules/ssh/hosts-prefill";
import { collectRecentTerminalDirs } from "@/ui/overlays/command-palette-recents";
import { useSshProfilesPanel } from "./useSshProfilesPanel";

interface WorkspaceEmptyStateProps {
  onNewTerminal: () => void;
  onNewTerminalInDirectory: () => void;
  onOpenSsh: () => void;
}

const launchButtonStyle: CSSProperties = {
  padding: "8px 16px",
  borderRadius: "var(--r-btn)",
  border: "1px solid var(--c-control-border)",
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
  const { panel } = useSshProfilesPanel();
  const recents = collectRecentTerminalDirs(recentDirs, undefined, 3);
  const hosts = [
    ...panel.savedProfiles.map((profile) => ({ profile, source: "saved" as const })),
    ...panel.configProfiles.map((profile) => ({ profile, source: "sshConfig" as const })),
  ].slice(0, 3);

  return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", minWidth: 0, overflowY: "auto", padding: 24 }}>
      <div style={{ width: "min(560px, 100%)", display: "flex", flexDirection: "column", gap: 20 }}>
        <div role="group" aria-label={t("app.empty.actions")} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
          <button type="button" onClick={onNewTerminal} className="hover-bg" style={launchButtonStyle}>
            {t("app.empty.local_terminal")}
          </button>
          <button type="button" onClick={onNewTerminalInDirectory} className="hover-bg" style={launchButtonStyle}>
            {t("app.empty.choose_folder")}
          </button>
          <button type="button" onClick={onOpenSsh} className="hover-bg" style={launchButtonStyle}>
            {t("app.empty.connect_ssh")}
          </button>
        </div>
        {(recents.length > 0 || hosts.length > 0) && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 18, paddingTop: 14, borderTop: "1px solid var(--c-border-1)" }}>
            {recents.length > 0 && (
              <section aria-label={t("app.empty.recent")}>
                <div style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", marginBottom: 5 }}>
                  {t("app.empty.recent")}
                </div>
                {recents.map((entry) => (
                  <button
                    key={entry.dir}
                    type="button"
                    className="hover-bg"
                    title={entry.dir}
                    onClick={() => useSessionsStore.getState().newTerminalInDir(entry.dir)}
                    style={{ width: "100%", textAlign: "left", border: "none", background: "transparent", color: "var(--c-text-3)", fontSize: "var(--fs-secondary)", fontFamily: "var(--font-ui)", padding: "6px 8px", borderRadius: "var(--r-btn)", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    {entry.label}
                  </button>
                ))}
              </section>
            )}
            {hosts.length > 0 && (
              <section aria-label={t("sidebar.hosts.title")}>
                <div style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", marginBottom: 5 }}>
                  {t("sidebar.hosts.title")}
                </div>
                {hosts.map(({ profile, source }) => (
                  <button
                    key={`${source}:${profile.id}:${profile.host}`}
                    type="button"
                    className="hover-bg"
                    title={`${profile.user}@${profile.host}${profile.port === 22 ? "" : `:${profile.port}`}`}
                    onClick={() => useUIStore.getState().openSshConnect(sshConnectPrefillFromProfile(profile, panel, source))}
                    style={{ width: "100%", textAlign: "left", border: "none", background: "transparent", color: "var(--c-text-3)", fontSize: "var(--fs-secondary)", fontFamily: "var(--font-ui)", padding: "6px 8px", borderRadius: "var(--r-btn)", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                  >
                    {hostProfileButtonLabel(profile)}
                  </button>
                ))}
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
