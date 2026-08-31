import { useEffect, useState } from "react";
import { loadSshProfilesPanel } from "@/modules/ssh/hosts-bridge";
import type { SshProfilesPanelModelV1 } from "@/modules/ssh/hosts-model";
import { useUIStore } from "@/state/ui";

const EMPTY_PANEL: SshProfilesPanelModelV1 = {
  schemaVersion: 1,
  savedProfiles: [],
  configProfiles: [],
  configSkipped: 0,
  configDiagnostics: [],
};

export function useSshProfilesPanel() {
  const overlay = useUIStore((state) => state.overlay);
  const sshProfilesEpoch = useUIStore((state) => state.sshProfilesEpoch);
  const [panel, setPanel] = useState<SshProfilesPanelModelV1>(EMPTY_PANEL);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      setLoading(true);
      void loadSshProfilesPanel()
        .then((next) => { if (!cancelled) setPanel(next); })
        .catch(() => { if (!cancelled) setPanel(EMPTY_PANEL); })
        .finally(() => { if (!cancelled) setLoading(false); });
    };
    load();
    window.addEventListener("focus", load);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", load);
    };
  }, [overlay, sshProfilesEpoch]);

  return { panel, loading };
}
