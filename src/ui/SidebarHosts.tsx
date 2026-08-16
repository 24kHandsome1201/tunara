import { useEffect, useState } from "react";
import { useT } from "@/modules/i18n";
import { useUIStore } from "@/state/ui";
import { loadSshProfilesPanel } from "@/modules/ssh/hosts-bridge";
import { hostProfileButtonLabel, sshConnectPrefillFromProfile } from "@/modules/ssh/hosts-prefill";
import type { SshHostProfile, SshProfilesPanelModelV1 } from "@/modules/ssh/hosts-model";
import { liveSessionsOnEndpoint, representativeSession } from "@/modules/session/sidebar-groups";
import type { Session } from "./types";

const EMPTY_PANEL: SshProfilesPanelModelV1 = {
  schemaVersion: 1,
  savedProfiles: [],
  configProfiles: [],
  configSkipped: 0,
  configDiagnostics: [],
};

interface SidebarHostsProps {
  sessions: Session[];
  activeSessionId: string;
  onSelectSession: (id: string) => void;
}

export function SidebarHosts({ sessions, activeSessionId, onSelectSession }: SidebarHostsProps) {
  const t = useT();
  const overlay = useUIStore((state) => state.overlay);
  const sshProfilesEpoch = useUIStore((state) => state.sshProfilesEpoch);
  const [panel, setPanel] = useState<SshProfilesPanelModelV1>(EMPTY_PANEL);
  const [expandedOverride, setExpandedOverride] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void loadSshProfilesPanel()
        .then((next) => { if (!cancelled) setPanel(next); })
        .catch(() => { if (!cancelled) setPanel(EMPTY_PANEL); });
    };
    load();
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, [overlay, sshProfilesEpoch]);

  const profiles: SshHostProfile[] = [...panel.savedProfiles, ...panel.configProfiles].slice(0, 8);
  if (profiles.length === 0) return null;

  const expanded = expandedOverride ?? sessions.length === 0;

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
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          style={{
            transform: expanded ? "rotate(90deg)" : "none",
            transition: "transform var(--duration-normal) var(--ease-out-back)",
            flexShrink: 0,
          }}
        >
          <polyline points="9 6 15 12 9 18" />
        </svg>
      </button>
      {expanded && (
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          {profiles.map((profile) => {
            const live = liveSessionsOnEndpoint(sessions, profile);
            const latest = representativeSession(live, activeSessionId);
            return (
              <button
                key={`${profile.id}:${profile.host}`}
                className="hover-bg"
                title={latest ? t("sidebar.hosts.focus_session") : hostProfileButtonLabel(profile)}
                onClick={() => {
                  if (latest) {
                    onSelectSession(latest.id);
                    return;
                  }
                  useUIStore.getState().openSshConnect(sshConnectPrefillFromProfile(profile, panel, panel.savedProfiles.some((item) => item.id === profile.id) ? "saved" : "sshConfig"));
                }}
                style={{
                  textAlign: "left",
                  border: "none",
                  background: "transparent",
                  color: "var(--c-text-2)",
                  fontSize: "var(--fs-secondary)",
                  fontFamily: "var(--font-ui)",
                  cursor: "pointer",
                  borderRadius: "var(--r-btn)",
                  padding: "5px 8px",
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {hostProfileButtonLabel(profile)}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
