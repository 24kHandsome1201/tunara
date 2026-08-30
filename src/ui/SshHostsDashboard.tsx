import { useEffect, useMemo, useState } from "react";
import { useT } from "@/modules/i18n";
import { loadSshProfilesPanel, type SshHostProfile, type SshProfileSourceV1, type SshProfilesPanelModelV1 } from "@/modules/ssh/hosts-bridge";
import { hostProfileButtonLabel, sshConnectPrefillFromProfile } from "@/modules/ssh/hosts-prefill";
import {
  calculateSshSystemRates,
  sshSystemSnapshotV1,
  type SshSystemSnapshotV1,
} from "@/modules/ssh/system-monitor-bridge";
import { liveSessionsOnEndpoint, representativeSession, sidebarGroupKeyFromEndpoint } from "@/modules/session/sidebar-groups";
import { readyBindingForSession } from "@/modules/terminal/lib/connection-state";
import type { SessionBindingV1 } from "@/modules/terminal/lib/pty-bridge";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { SearchIcon } from "./shared";
import type { Session } from "./types";

type HostFilter = "all" | "online" | "offline";

interface DashboardHost {
  key: string;
  source: SshProfileSourceV1;
  profile: SshHostProfile;
}

interface MonitorReading {
  status: "available" | "unsupported" | "unavailable";
  bindingGeneration: string;
  snapshot?: SshSystemSnapshotV1;
  downloadBytesPerSecond?: number;
  uploadBytesPerSecond?: number;
  downloadHistory: number[];
  uploadHistory: number[];
}

interface MonitorTarget {
  endpointKey: string;
  binding: SessionBindingV1;
  hostKeys: string[];
}

const EMPTY_PANEL: SshProfilesPanelModelV1 = {
  schemaVersion: 1,
  savedProfiles: [],
  configProfiles: [],
  configSkipped: 0,
  configDiagnostics: [],
};

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let index = 0;
  while (amount >= 1024 && index < units.length - 1) {
    amount /= 1024;
    index += 1;
  }
  const digits = amount >= 100 || index === 0 ? 0 : amount >= 10 ? 1 : 2;
  return `${amount.toFixed(digits)} ${units[index]}`;
}

function formatRate(value: number | undefined): string {
  return value === undefined ? "—" : `${formatBytes(value)}/s`;
}

function formatUptime(value: number | undefined, t: ReturnType<typeof useT>): string {
  if (value === undefined) return "—";
  const days = Math.floor(value / 86_400);
  const hours = Math.floor((value % 86_400) / 3_600);
  const minutes = Math.floor((value % 3_600) / 60);
  if (days > 0) return t("ssh.dashboard.uptime_days", { days, hours });
  if (hours > 0) return t("ssh.dashboard.uptime_hours", { hours, minutes });
  return t("ssh.dashboard.uptime_minutes", { minutes });
}

function memoryValues(snapshot: SshSystemSnapshotV1 | undefined) {
  if (snapshot?.status !== "available") return null;
  const used = Math.max(0, snapshot.memoryTotalBytes - snapshot.memoryAvailableBytes);
  const percent = snapshot.memoryTotalBytes > 0
    ? Math.max(0, Math.min(100, (used / snapshot.memoryTotalBytes) * 100))
    : 0;
  return { used, total: snapshot.memoryTotalBytes, percent };
}

function Sparkline({ values, tone }: { values: number[]; tone: "download" | "upload" }) {
  const width = 132;
  const height = 34;
  const max = Math.max(...values, 1);
  const points = values.length > 1
    ? values.map((value, index) => `${(index / (values.length - 1)) * width},${height - (value / max) * (height - 3) - 1.5}`).join(" ")
    : `0,${height - 2} ${width},${height - 2}`;
  return (
    <svg className="ssh-monitor-sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true" data-tone={tone}>
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ServerIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <path d="M7 7.5h.01M7 16.5h.01M11 7.5h6M11 16.5h6" />
    </svg>
  );
}

function connectionState(live: Session[]) {
  const ready = live.find((session) => readyBindingForSession(session));
  if (ready) return { kind: "online" as const, ready };
  if (live.some((session) => session.connection && !["failed", "disconnected", "exited"].includes(session.connection.phase))) {
    return { kind: "connecting" as const };
  }
  return { kind: "offline" as const };
}

function readingMessage(reading: MonitorReading | undefined, online: boolean, t: ReturnType<typeof useT>): string {
  if (!online) return t("ssh.dashboard.monitor.no_data");
  if (!reading) return t("ssh.dashboard.monitor.sampling");
  if (reading.status === "unsupported") return t("ssh.dashboard.monitor.unsupported");
  if (reading.status === "unavailable") return t("ssh.dashboard.monitor.unavailable");
  return "";
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
  const [readings, setReadings] = useState<Record<string, MonitorReading>>({});
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

  const monitorTargets = useMemo<MonitorTarget[]>(() => {
    const targets = new Map<string, MonitorTarget>();
    // Filtering changes presentation only. Keep every connected endpoint
    // sampled so an open detail panel cannot silently freeze when its card is
    // hidden by a search or status filter.
    for (const entry of hosts) {
      const endpointKey = sidebarGroupKeyFromEndpoint(entry.profile);
      const live = liveSessionsOnEndpoint(sessions, entry.profile);
      const representative = representativeSession(live.filter((session) => readyBindingForSession(session)), useSessionsStore.getState().activeSessionId ?? "");
      const binding = readyBindingForSession(representative);
      if (!binding) continue;
      const existing = targets.get(endpointKey);
      if (existing) existing.hostKeys.push(entry.key);
      else targets.set(endpointKey, { endpointKey, binding, hostKeys: [entry.key] });
    }
    return [...targets.values()];
  }, [hosts, sessions]);
  const monitorSignature = JSON.stringify(monitorTargets.map((target) => ({
    endpointKey: target.endpointKey,
    binding: target.binding,
    hostKeys: target.hostKeys,
  })));

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const sample = async () => {
      if (inFlight || monitorTargets.length === 0) return;
      inFlight = true;
      await Promise.all(monitorTargets.map(async (target) => {
        try {
          const snapshot = await sshSystemSnapshotV1(target.binding);
          if (cancelled) return;
          setReadings((current) => {
            const next = { ...current };
            for (const hostKey of target.hostKeys) {
              const previous = current[hostKey];
              if (snapshot.status === "unsupported") {
                next[hostKey] = {
                  status: "unsupported",
                  bindingGeneration: target.binding.transportGeneration,
                  snapshot,
                  downloadHistory: [],
                  uploadHistory: [],
                };
                continue;
              }
              const previousSnapshot = previous?.status === "available"
                && previous.bindingGeneration === target.binding.transportGeneration
                ? previous.snapshot
                : undefined;
              const rates = calculateSshSystemRates(previousSnapshot, snapshot);
              next[hostKey] = {
                status: "available",
                bindingGeneration: target.binding.transportGeneration,
                snapshot,
                downloadBytesPerSecond: rates?.downloadBytesPerSecond,
                uploadBytesPerSecond: rates?.uploadBytesPerSecond,
                downloadHistory: rates
                  ? [...(previous?.downloadHistory ?? []), rates.downloadBytesPerSecond].slice(-20)
                  : [],
                uploadHistory: rates
                  ? [...(previous?.uploadHistory ?? []), rates.uploadBytesPerSecond].slice(-20)
                  : [],
              };
            }
            return next;
          });
        } catch {
          if (cancelled) return;
          setReadings((current) => {
            const next = { ...current };
            for (const hostKey of target.hostKeys) {
              next[hostKey] = {
                status: "unavailable",
                bindingGeneration: target.binding.transportGeneration,
                downloadHistory: [],
                uploadHistory: [],
              };
            }
            return next;
          });
        }
      }));
      inFlight = false;
    };
    void sample();
    const timer = window.setInterval(() => { void sample(); }, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // The signature contains the generation-safe bindings and visible profile keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monitorSignature]);

  const selected = hosts.find((host) => host.key === selectedKey) ?? null;
  const selectedLive = selected ? liveSessionsOnEndpoint(sessions, selected.profile) : [];
  const selectedConnection = connectionState(selectedLive);
  const selectedBinding = selectedConnection.ready ? readyBindingForSession(selectedConnection.ready) : undefined;
  const storedSelectedReading = selected ? readings[selected.key] : undefined;
  const selectedReading = selectedBinding
    && storedSelectedReading?.bindingGeneration === selectedBinding.transportGeneration
    ? storedSelectedReading
    : undefined;

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
              const online = connection.kind === "online";
              const binding = connection.ready ? readyBindingForSession(connection.ready) : undefined;
              const storedReading = readings[entry.key];
              const reading = binding && storedReading?.bindingGeneration === binding.transportGeneration
                ? storedReading
                : undefined;
              const memory = memoryValues(reading?.snapshot);
              const message = readingMessage(reading, online, t);
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
                  {memory && reading?.status === "available" ? (
                    <>
                      <span className="ssh-host-memory-row">
                        <span>{t("ssh.dashboard.memory")}</span>
                        <b>{formatBytes(memory.used)} / {formatBytes(memory.total)}</b>
                      </span>
                      <span className="ssh-host-memory-bar" aria-label={t("ssh.dashboard.memory_percent", { percent: Math.round(memory.percent) })}>
                        <i style={{ width: `${memory.percent}%` }} />
                      </span>
                      <span className="ssh-host-network">
                        <span><small>↓ {t("ssh.dashboard.download")}</small><b>{formatRate(reading.downloadBytesPerSecond)}</b></span>
                        <span><small>↑ {t("ssh.dashboard.upload")}</small><b>{formatRate(reading.uploadBytesPerSecond)}</b></span>
                      </span>
                    </>
                  ) : (
                    <span className="ssh-host-no-monitor">{message}</span>
                  )}
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
                <div><dt>{t("ssh.dashboard.uptime")}</dt><dd>{formatUptime(selectedReading?.snapshot?.status === "available" ? selectedReading.snapshot.uptimeSeconds : undefined, t)}</dd></div>
              </dl>
            </section>

            <section className="ssh-host-detail-section">
              <div className="ssh-host-detail-section-title">
                <h2>{t("ssh.dashboard.realtime")}</h2>
                <span>{t("ssh.dashboard.refresh_interval")}</span>
              </div>
              {memoryValues(selectedReading?.snapshot) && selectedReading?.status === "available" ? (() => {
                const memory = memoryValues(selectedReading.snapshot)!;
                return (
                  <div className="ssh-host-monitor-detail">
                    <div className="ssh-host-memory-detail">
                      <span><small>{t("ssh.dashboard.memory")}</small><b>{Math.round(memory.percent)}%</b></span>
                      <span className="ssh-host-memory-bar"><i style={{ width: `${memory.percent}%` }} /></span>
                      <em>{formatBytes(memory.used)} {t("ssh.dashboard.used_of", { total: formatBytes(memory.total) })}</em>
                    </div>
                    <div className="ssh-host-network-detail">
                      <div>
                        <span><small>↓ {t("ssh.dashboard.download")}</small><b>{formatRate(selectedReading.downloadBytesPerSecond)}</b></span>
                        <Sparkline values={selectedReading.downloadHistory} tone="download" />
                      </div>
                      <div>
                        <span><small>↑ {t("ssh.dashboard.upload")}</small><b>{formatRate(selectedReading.uploadBytesPerSecond)}</b></span>
                        <Sparkline values={selectedReading.uploadHistory} tone="upload" />
                      </div>
                    </div>
                  </div>
                );
              })() : (
                <div className="ssh-host-monitor-empty">{readingMessage(selectedReading, selectedConnection.kind === "online", t)}</div>
              )}
              <p className="ssh-host-monitor-note">{t("ssh.dashboard.monitor.note")}</p>
            </section>
          </div>
        </aside>
      )}
    </main>
    </div>
  );
}
