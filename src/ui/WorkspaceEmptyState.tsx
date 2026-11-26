import { useEffect, useId, useState } from "react";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { useT } from "@/modules/i18n";
import { hostProfileButtonLabel, sshConnectPrefillFromEntry } from "@/modules/ssh/hosts-prefill";
import { sshProfileEntries } from "@/modules/ssh/hosts-model";
import { fsScanRecentRepos } from "@/modules/fs/fs-bridge";
import {
  emptyStateRecentDirs,
  nearbyReposNotInRecents,
  type NearbyGitRepo,
} from "@/modules/session/empty-state-dirs";
import { ArrowRight, CaretRight, FolderSimple, HardDrives, Icon, Terminal, type IconGlyph } from "./icons";
import { useSshProfilesPanel } from "./useSshProfilesPanel";

interface WorkspaceEmptyStateProps {
  onNewTerminal: () => void;
  onNewTerminalInDirectory: () => void;
  onOpenSsh: () => void;
}

interface LaunchButtonProps {
  icon: IconGlyph;
  label: string;
  detail: string;
  onClick: () => void;
  title?: string;
  variant?: "primary" | "action" | "row";
}

function LaunchButton({ icon, label, detail, onClick, title, variant = "row" }: LaunchButtonProps) {
  const detailId = useId();
  const isRow = variant === "row";
  return (
    <button
      type="button"
      className={`workspace-empty-button ${isRow ? "workspace-empty-row" : "workspace-empty-action"}`}
      data-primary={variant === "primary" || undefined}
      title={title}
      aria-label={label}
      aria-describedby={detailId}
      onClick={onClick}
    >
      <span className="workspace-empty-icon"><Icon icon={icon} size={isRow ? 14 : 16} /></span>
      <span className="workspace-empty-copy">
        <strong>{label}</strong>
        <small id={detailId}>{detail}</small>
      </span>
      <Icon icon={isRow ? CaretRight : ArrowRight} className="workspace-empty-arrow" size={isRow ? 12 : 16} />
    </button>
  );
}

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
  const hosts = sshProfileEntries(panel).slice(0, 3);

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
    <div className="workspace-empty">
      <div className="workspace-empty-content">
        <div className="workspace-empty-intro">
          <span className="workspace-empty-icon"><Icon icon={Terminal} size={22} /></span>
          <h2>{t("app.empty.title")}</h2>
          <p>{t("app.empty.guide")}</p>
        </div>
        <div role="group" aria-label={t("app.empty.actions")} className="workspace-empty-actions">
          <div className="workspace-empty-cards">
            <LaunchButton
              variant="primary"
              icon={FolderSimple}
              onClick={onNewTerminalInDirectory}
              label={t("app.empty.open_terminal_in_folder")}
              detail={t("app.empty.folder_hint")}
            />
            <LaunchButton
              variant="action"
              icon={HardDrives}
              onClick={onOpenSsh}
              label={t("app.empty.connect_ssh")}
              detail={t("app.empty.ssh_hint")}
            />
          </div>
          <button type="button" className="workspace-empty-button workspace-empty-local" onClick={onNewTerminal}>
            <Icon icon={Terminal} size={15} />
            {t("app.empty.local_terminal")}
          </button>
        </div>
        {hasSuggestions && (
          <div className="workspace-empty-suggestions">
            {hosts.length > 0 && (
              <section className="workspace-empty-hosts" aria-label={t("app.empty.saved_ssh_hosts")}>
                <h3>{t("app.empty.saved_ssh_hosts")}</h3>
                <div className="workspace-empty-list">
                  {hosts.map((entry) => {
                    const { profile } = entry;
                    const endpoint = `${profile.user}@${profile.host}${profile.port === 22 ? "" : `:${profile.port}`}`;
                    return (
                      <LaunchButton
                        key={`${entry.key}:${profile.host}`}
                        icon={HardDrives}
                        title={endpoint}
                        label={hostProfileButtonLabel(profile)}
                        detail={endpoint}
                        onClick={() => useUIStore.getState().openSshConnect(sshConnectPrefillFromEntry(entry, panel))}
                      />
                    );
                  })}
                </div>
              </section>
            )}
            {(recents.length > 0 || suggested.length > 0) && (
              <div className="workspace-empty-directories">
                {recents.length > 0 && (
                  <section aria-label={t("app.empty.recent")}>
                    <h3>{t("app.empty.recent")}</h3>
                    <div className="workspace-empty-list">
                      {recents.map((entry) => (
                        <LaunchButton
                          key={entry.dir}
                          icon={FolderSimple}
                          title={entry.dir}
                          label={entry.label}
                          detail={t("common.new_terminal_here")}
                          onClick={() => useSessionsStore.getState().newTerminalInDir(entry.dir)}
                        />
                      ))}
                    </div>
                  </section>
                )}
                {suggested.length > 0 && (
                  <section aria-label={t("app.empty.nearby")}>
                    <h3>{t("app.empty.nearby")}</h3>
                    <div className="workspace-empty-list">
                      {suggested.map((repo) => (
                        <LaunchButton
                          key={repo.path}
                          icon={FolderSimple}
                          title={repo.path}
                          label={repo.name}
                          detail={t("common.new_terminal_here")}
                          onClick={() => useSessionsStore.getState().newTerminalInDir(repo.path)}
                        />
                      ))}
                    </div>
                  </section>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
