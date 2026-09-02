import { useEffect, useState, type CSSProperties } from "react";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { useT } from "@/modules/i18n";
import { hostProfileButtonLabel, sshConnectPrefillFromProfile } from "@/modules/ssh/hosts-prefill";
import { fsScanRecentRepos } from "@/modules/fs/fs-bridge";
import {
  emptyStateRecentDirs,
  nearbyReposNotInRecents,
  type NearbyGitRepo,
} from "@/modules/session/empty-state-dirs";
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

const cardButtonStyle: CSSProperties = {
  width: "100%",
  textAlign: "left",
  border: "1px solid var(--c-border-1)",
  background: "var(--c-bg-white)",
  color: "var(--c-text-3)",
  fontSize: "var(--fs-secondary)",
  fontFamily: "var(--font-ui)",
  padding: "10px 12px",
  borderRadius: "var(--r-btn)",
  cursor: "pointer",
  display: "flex",
  flexDirection: "column",
  gap: 2,
  minWidth: 0,
};

export function WorkspaceEmptyState({
  onNewTerminal,
  onNewTerminalInDirectory,
  onOpenSsh,
}: WorkspaceEmptyStateProps) {
  const t = useT();
  const recentDirs = useSessionsStore((s) => s.recentDirs);
  const { panel } = useSshProfilesPanel();
  const recents = emptyStateRecentDirs(recentDirs, 3);
  const [nearby, setNearby] = useState<NearbyGitRepo[]>([]);
  const hosts = [
    ...panel.savedProfiles.map((profile) => ({ profile, source: "saved" as const })),
    ...panel.configProfiles.map((profile) => ({ profile, source: "sshConfig" as const })),
  ].slice(0, 3);

  useEffect(() => {
    let cancelled = false;
    void fsScanRecentRepos()
      .then((repos) => {
        if (!cancelled) setNearby(Array.isArray(repos) ? repos : []);
      })
      .catch(() => {
        if (!cancelled) setNearby([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const suggested = nearbyReposNotInRecents(recents, nearby, 6);
  const hasSuggestions = recents.length > 0 || suggested.length > 0 || hosts.length > 0;

  return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", minWidth: 0, overflowY: "auto", padding: 24 }}>
      <div style={{ width: "min(560px, 100%)", display: "flex", flexDirection: "column", gap: 20 }}>
        <div role="group" aria-label={t("app.empty.actions")} className="workspace-empty-actions" style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
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
        {hasSuggestions && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 18, paddingTop: 14, borderTop: "1px solid var(--c-border-1)" }}>
            {recents.length > 0 && (
              <section aria-label={t("app.empty.recent")}>
                <div style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", marginBottom: 8 }}>
                  {t("app.empty.recent")}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {recents.map((entry) => (
                    <button
                      key={entry.dir}
                      type="button"
                      className="hover-bg"
                      title={entry.dir}
                      aria-label={entry.label}
                      onClick={() => useSessionsStore.getState().newTerminalInDir(entry.dir)}
                      style={cardButtonStyle}
                    >
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600, color: "var(--c-text-2)" }}>
                        {entry.label}
                      </span>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "var(--fs-meta)", color: "var(--c-text-5)" }}>
                        {t("app.empty.open_here")}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            )}
            {suggested.length > 0 && (
              <section aria-label={t("app.empty.nearby")}>
                <div style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", marginBottom: 8 }}>
                  {t("app.empty.nearby")}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {suggested.map((repo) => (
                    <button
                      key={repo.path}
                      type="button"
                      className="hover-bg"
                      title={repo.path}
                      aria-label={repo.name}
                      onClick={() => useSessionsStore.getState().newTerminalInDir(repo.path)}
                      style={cardButtonStyle}
                    >
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600, color: "var(--c-text-2)" }}>
                        {repo.name}
                      </span>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "var(--fs-meta)", color: "var(--c-text-5)" }}>
                        {t("app.empty.open_here")}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            )}
            {hosts.length > 0 && (
              <section aria-label={t("sidebar.hosts.title")}>
                <div style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", marginBottom: 8 }}>
                  {t("sidebar.hosts.title")}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {hosts.map(({ profile, source }) => (
                    <button
                      key={`${source}:${profile.id}:${profile.host}`}
                      type="button"
                      className="hover-bg"
                      title={`${profile.user}@${profile.host}${profile.port === 22 ? "" : `:${profile.port}`}`}
                      aria-label={hostProfileButtonLabel(profile)}
                      onClick={() => useUIStore.getState().openSshConnect(sshConnectPrefillFromProfile(profile, panel, source))}
                      style={cardButtonStyle}
                    >
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600, color: "var(--c-text-2)" }}>
                        {hostProfileButtonLabel(profile)}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
