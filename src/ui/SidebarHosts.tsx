import { useState } from "react";
import { useT } from "@/modules/i18n";
import { useUIStore } from "@/state/ui";
import { hostProfileButtonLabel, sshConnectPrefillFromProfile } from "@/modules/ssh/hosts-prefill";
import type { SshProfilesPanelModelV1, SshProfileSourceV1 } from "@/modules/ssh/hosts-model";
import { liveSessionsOnEndpoint, representativeSession } from "@/modules/session/sidebar-groups";
import { readyBindingForSession } from "@/modules/terminal/lib/connection-state";
import type { Session } from "./types";
import { useSshProfilesPanel } from "./useSshProfilesPanel";
import { CaretRight, HardDrives, Icon } from "@/ui/icons";

interface SidebarHostsProps {
  sessions: Session[];
  activeSessionId: string;
  onSelectSession: (id: string) => void;
}

export function SidebarHosts({ sessions, activeSessionId, onSelectSession }: SidebarHostsProps) {
  const t = useT();
  const mainSurface = useUIStore((state) => state.mainSurface);
  const { panel, loading } = useSshProfilesPanel();
  const [expandedOverride, setExpandedOverride] = useState<boolean | null>(null);

  const profiles: Array<{ profile: SshProfilesPanelModelV1["savedProfiles"][number]; source: SshProfileSourceV1 }> = [
    ...panel.savedProfiles.map((profile) => ({ profile, source: "saved" as const })),
    ...panel.configProfiles.map((profile) => ({ profile, source: "sshConfig" as const })),
  ];
  const visibleProfiles = profiles.slice(0, 8);

  const expanded = expandedOverride ?? (sessions.length === 0 || mainSurface === "ssh-hosts");

  return (
    <section aria-label={t("sidebar.hosts.aria_label")} style={{ padding: "0 12px 8px" }}>
      <button
        type="button"
        className="hover-bg"
        aria-expanded={expanded}
        onClick={() => setExpandedOverride(!expanded)}
        title={expanded ? t("sidebar.hosts.collapse") : t("sidebar.hosts.expand")}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          width: "100%",
          border: "none",
          background: "transparent",
          color: "var(--c-text-5)",
          fontSize: "var(--fs-meta)",
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          padding: "4px 2px 6px",
          cursor: "pointer",
          fontFamily: "var(--font-ui)",
          textAlign: "left",
        }}
      >
        <span>{t("sidebar.hosts.count", { count: profiles.length })}</span>
        <Icon
          icon={CaretRight}
          size={10}
          weight="bold"
          style={{
            transform: expanded ? "rotate(90deg)" : "none",
            transition: "transform var(--dur-base) var(--ease-out)",
            flexShrink: 0,
          }}
        />
      </button>
      {expanded && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <button
            type="button"
            className="hover-bg sidebar-hosts-manage"
            aria-current={mainSurface === "ssh-hosts" ? "page" : undefined}
            onClick={() => useUIStore.getState().openSshHosts()}
          >
            <span className="sidebar-hosts-manage-icon" aria-hidden="true">
              <Icon icon={HardDrives} size={13} />
            </span>
            <span>{t("sidebar.hosts.manage")}</span>
            <span aria-hidden="true" style={{ marginLeft: "auto" }}>›</span>
          </button>
          {loading && profiles.length === 0 && <span className="sidebar-hosts-state" role="status">{t("sidebar.hosts.loading")}</span>}
          {!loading && profiles.length === 0 && <span className="sidebar-hosts-state">{t("sidebar.hosts.empty")}</span>}
          {visibleProfiles.map(({ profile, source }) => {
            const live = liveSessionsOnEndpoint(sessions, profile);
            const latest = representativeSession(live, activeSessionId);
            const online = live.some((session) => readyBindingForSession(session));
            const connecting = !online && live.some((session) => session.connection && !["failed", "disconnected", "exited"].includes(session.connection.phase));
            return (
              <button
                key={`${source}:${profile.id}:${profile.host}`}
                className="hover-bg sidebar-host-row"
                data-status={online ? "online" : connecting ? "connecting" : "offline"}
                aria-label={hostProfileButtonLabel(profile)}
                title={latest ? t("sidebar.hosts.focus_session") : hostProfileButtonLabel(profile)}
                onClick={() => {
                  if (latest) {
                    onSelectSession(latest.id);
                    return;
                  }
                  useUIStore.getState().openSshConnect(sshConnectPrefillFromProfile(profile, panel, source));
                }}
              >
                <span className="sidebar-host-status-dot" aria-hidden="true" />
                <span className="sidebar-host-copy">
                  <strong>{hostProfileButtonLabel(profile)}</strong>
                  <small>{profile.user}@{profile.host}{profile.port === 22 ? "" : `:${profile.port}`} · {source === "saved" ? t("ssh.source.saved") : "config"}</small>
                </span>
              </button>
            );
          })}
          {profiles.length > visibleProfiles.length && (
            <button type="button" className="sidebar-hosts-more" onClick={() => useUIStore.getState().openSshHosts()}>
              {t("sidebar.hosts.more", { count: profiles.length - visibleProfiles.length })}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
