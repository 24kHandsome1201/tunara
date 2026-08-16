import { useEffect, useState } from "react";
import { useT } from "@/modules/i18n";
import { useUIStore } from "@/state/ui";
import { loadSshProfilesPanel } from "@/modules/ssh/hosts-bridge";
import { hostProfileButtonLabel, sshConnectPrefillFromProfile } from "@/modules/ssh/hosts-prefill";
import type { SshHostProfile, SshProfilesPanelModelV1 } from "@/modules/ssh/hosts-model";

const EMPTY_PANEL: SshProfilesPanelModelV1 = {
  schemaVersion: 1,
  savedProfiles: [],
  configProfiles: [],
  configSkipped: 0,
  configDiagnostics: [],
};

export function SidebarHosts() {
  const t = useT();
  const overlay = useUIStore((state) => state.overlay);
  const [panel, setPanel] = useState<SshProfilesPanelModelV1>(EMPTY_PANEL);

  useEffect(() => {
    let cancelled = false;
    void loadSshProfilesPanel()
      .then((next) => { if (!cancelled) setPanel(next); })
      .catch(() => { if (!cancelled) setPanel(EMPTY_PANEL); });
    return () => { cancelled = true; };
  }, [overlay]);

  const profiles: SshHostProfile[] = [...panel.savedProfiles, ...panel.configProfiles].slice(0, 8);
  if (profiles.length === 0) return null;

  return (
    <section aria-label={t("sidebar.hosts.aria_label")} style={{ padding: "0 12px 8px" }}>
      <div style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", letterSpacing: "0.04em", textTransform: "uppercase", padding: "4px 2px 6px" }}>
        {t("sidebar.hosts.title")}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {profiles.map((profile) => (
          <button
            key={`${profile.id}:${profile.host}`}
            className="hover-bg"
            title={hostProfileButtonLabel(profile)}
            onClick={() => useUIStore.getState().openSshConnect(sshConnectPrefillFromProfile(profile, panel, panel.savedProfiles.some((item) => item.id === profile.id) ? "saved" : "sshConfig"))}
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
        ))}
      </div>
    </section>
  );
}
