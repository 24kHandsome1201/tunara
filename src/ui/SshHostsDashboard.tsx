import { useEffect, useMemo, useState } from "react";
import { useT } from "@/modules/i18n";
import { loadSshProfilesPanel, type SshHostProfile, type SshProfileSourceV1, type SshProfilesPanelModelV1 } from "@/modules/ssh/hosts-bridge";
import { hostProfileButtonLabel, sshConnectPrefillFromProfile } from "@/modules/ssh/hosts-prefill";
import { liveSessionsOnEndpoint, representativeSession } from "@/modules/session/sidebar-groups";
import { readyBindingForSession } from "@/modules/terminal/lib/connection-state";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { SearchIcon } from "./shared";
import { HardDrives, Icon } from "@/ui/icons";
import type { Session } from "./types";

type HostFilter = "all" | "online" | "offline";

interface DashboardHost {
  key: string;
  source: SshProfileSourceV1;
  profile: SshHostProfile;
}

const EMPTY_PANEL: SshProfilesPanelModelV1 = {
  schemaVersion: 1,
  savedProfiles: [],
  configProfiles: [],
  configSkipped: 0,
  configDiagnostics: [],
};

function ServerIcon() {
  return <Icon icon={HardDrives} size={18} />;
}

function connectionState(live: Session[]) {
  const ready = live.find((session) => readyBindingForSession(session));
  if (ready) return { kind: "online" as const, ready };
  if (live.some((session) => session.connection && !["failed", "disconnected", "exited"].includes(session.connection.phase))) {
    return { kind: "connecting" as const };
  }
  return { kind: "offline" as const };
}

export function SshHostsDashboard({ sessions }: { sessions: Session[] }) {
  const t = useT();
  const sshProfilesEpoch = useUIStore((state) => state.sshProfilesEpoch);
  const [panel, setPanel] = useState(EMPTY_PANEL);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<HostFilter>("all");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [loadNonce, setLoadNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);
    void loadSshProfilesPanel()
      .then((next) => {
        if (!cancelled) setPanel(next);
      })
      .catch(() => {
        if (!cancelled) {
          setPanel(EMPTY_PANEL);
          setLoadFailed(true);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [loadNonce, sshProfilesEpoch]);

  const hosts = useMemo<DashboardHost[]>(() => [
    ...panel.savedProfiles.map((profile) => ({ key: `saved:${profile.id}`, source: "saved" as const, profile })),
    ...panel.configProfiles.map((profile) => ({ key: `sshConfig:${profile.id}`, source: "sshConfig" as const, profile })),
  ], [panel]);

  useEffect(() => {
    if (hosts.length === 0) {
      setSelectedKey(null);
      return;
    }
    if (selectedKey && !hosts.some((host) => host.key === selectedKey)) setSelectedKey(null);
  }, [hosts, selectedKey]);

  const visibleHosts = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return hosts.filter((entry) => {
      const live = liveSessionsOnEndpoint(sessions, entry.profile);
      const online = connectionState(live).kind === "online";
      if (filter === "online" && !online) return false;
      if (filter === "offline" && online) return false;
      if (!normalized) return true;
      const profile = entry.profile;
      return `${profile.label} ${profile.user} ${profile.host} ${profile.port}`.toLowerCase().includes(normalized);
    });
  }, [filter, hosts, query, sessions]);

  const selected = hosts.find((host) => host.key === selectedKey) ?? null;
  const selectedLive = selected ? liveSessionsOnEndpoint(sessions, selected.profile) : [];
  const selectedConnection = connectionState(selectedLive);

  const openConnection = (entry: DashboardHost) => {
    const live = liveSessionsOnEndpoint(useSessionsStore.getState().sessions, entry.profile);
    const current = representativeSession(live.filter((session) => readyBindingForSession(session)), useSessionsStore.getState().activeSessionId ?? "");
    if (current) {
      useSessionsStore.getState().setActive(current.id);
      useUIStore.getState().showTerminal();
      return;
    }
    useUIStore.getState().openSshConnect(sshConnectPrefillFromProfile(entry.profile, panel, entry.source));
  };

  return (
    <div className="ssh-dashboard-container">
    <main className="ssh-dashboard" data-detail-open={selected ? "true" : "false"} aria-labelledby="ssh-dashboard-title">
      <section className="ssh-dashboard-list">
        <header className="ssh-dashboard-header">
          <div>
            <span className="ssh-dashboard-kicker">SSH</span>
            <h1 id="ssh-dashboard-title">{t("ssh.dashboard.title")}</h1>
            <p>{t("ssh.dashboard.subtitle")}</p>
          </div>
          <button type="button" className="ui-button ui-button--primary ssh-dashboard-add" onClick={() => useUIStore.getState().openSshConnect()}>
            <span aria-hidden="true">＋</span>{t("ssh.dashboard.add")}
          </button>
        </header>

        <div className="ssh-dashboard-toolbar">
          <label className="ssh-dashboard-search">
            <SearchIcon />
            <span className="sr-only">{t("ssh.dashboard.search")}</span>
            <input className="ui-control" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("ssh.dashboard.search")} />
          </label>
          <div className="ssh-dashboard-filters" role="group" aria-label={t("ssh.dashboard.filter.label")}>
            {(["all", "online", "offline"] as const).map((value) => (
              <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>
                {t(`ssh.dashboard.filter.${value}`)}
              </button>
            ))}
          </div>
          <span className="ssh-dashboard-count">{t("ssh.dashboard.count", { count: visibleHosts.length })}</span>
        </div>

        <div className="ssh-dashboard-scroll">
          {loading && <div className="ssh-dashboard-state" role="status">{t("ssh.dashboard.loading")}</div>}
          {!loading && loadFailed && (
            <div className="ssh-dashboard-state" role="alert">
              <strong>{t("ssh.dashboard.load_failed")}</strong>
              <button type="button" className="ui-button" onClick={() => setLoadNonce((value) => value + 1)}>{t("common.retry")}</button>
            </div>
          )}
          {!loading && !loadFailed && hosts.length === 0 && (
            <div className="ssh-dashboard-empty">
              <span className="ssh-dashboard-empty-icon"><ServerIcon /></span>
              <strong>{t("ssh.dashboard.empty.title")}</strong>
              <span>{t("ssh.dashboard.empty.detail")}</span>
              <button type="button" className="ui-button ui-button--primary" onClick={() => useUIStore.getState().openSshConnect()}>{t("ssh.dashboard.add")}</button>
            </div>
          )}
          {!loading && !loadFailed && hosts.length > 0 && visibleHosts.length === 0 && (
            <div className="ssh-dashboard-state" role="status">{t("ssh.dashboard.no_match")}</div>
          )}
          <div className="ssh-host-grid">
            {visibleHosts.map((entry) => {
              const live = liveSessionsOnEndpoint(sessions, entry.profile);
              const connection = connectionState(live);
              return (
                <button
                  key={entry.key}
                  type="button"
                  className="ssh-host-card"
                  data-selected={selectedKey === entry.key}
                  data-status={connection.kind}
                  aria-pressed={selectedKey === entry.key}
                  aria-label={t("ssh.dashboard.open_details", { name: hostProfileButtonLabel(entry.profile) })}
                  onClick={() => setSelectedKey(entry.key)}
                >
                  <span className="ssh-host-card-topline">
                    <span className="ssh-host-card-icon"><ServerIcon /></span>
                    <span className="ssh-host-card-identity">
                      <strong>{hostProfileButtonLabel(entry.profile)}</strong>
                      <span>{entry.profile.user}@{entry.profile.host}</span>
                    </span>
                    <span className="ssh-host-status"><i />{t(`ssh.dashboard.status.${connection.kind}`)}</span>
                  </span>
                  <span className="ssh-host-card-meta">
                    <span><small>{t("ssh.dashboard.address")}</small><b>{entry.profile.host}</b></span>
                    <span><small>{t("ssh.dashboard.port")}</small><b>{entry.profile.port}</b></span>
                    <span><small>{t("ssh.dashboard.source")}</small><b>{entry.source === "saved" ? t("ssh.source.saved") : "~/.ssh/config"}</b></span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      {selected && (
        <aside className="ssh-host-detail" aria-label={t("ssh.dashboard.details")}>
          <header className="ssh-host-detail-header">
            <button type="button" className="ssh-host-detail-back" onClick={() => setSelectedKey(null)} aria-label={t("common.back")}>←</button>
            <span className="ssh-host-detail-icon"><ServerIcon /></span>
            <span>
              <strong>{hostProfileButtonLabel(selected.profile)}</strong>
              <small>{selected.profile.user}@{selected.profile.host}:{selected.profile.port}</small>
            </span>
            <span className="ssh-host-status" data-status={selectedConnection.kind}><i />{t(`ssh.dashboard.status.${selectedConnection.kind}`)}</span>
          </header>

          <div className="ssh-host-detail-scroll">
            <div className="ssh-host-detail-actions">
              <button type="button" className="ui-button ui-button--primary" onClick={() => openConnection(selected)}>
                {selectedConnection.kind === "online" ? t("ssh.dashboard.open_terminal") : t("ssh.connect")}
              </button>
              <button type="button" className="ui-button" onClick={() => useUIStore.getState().openSshConnect(sshConnectPrefillFromProfile(selected.profile, panel, selected.source))}>
                {t("ssh.dashboard.edit")}
              </button>
            </div>

            <section className="ssh-host-detail-section">
              <h2>{t("ssh.dashboard.connection_info")}</h2>
              <dl className="ssh-host-facts">
                <div><dt>{t("ssh.dashboard.address")}</dt><dd>{selected.profile.host}</dd></div>
                <div><dt>{t("ssh.dashboard.port")}</dt><dd>{selected.profile.port}</dd></div>
                <div><dt>{t("ssh.user")}</dt><dd>{selected.profile.user}</dd></div>
                <div><dt>{t("ssh.dashboard.source")}</dt><dd>{selected.source === "saved" ? t("ssh.source.saved") : "~/.ssh/config"}</dd></div>
                <div><dt>{t("ssh.dashboard.sessions")}</dt><dd>{selectedLive.length}</dd></div>
              </dl>
            </section>
          </div>
        </aside>
      )}
    </main>
    </div>
  );
}
