import { useT } from "@/modules/i18n";
import { KnownHostsPanel } from "@/modules/ssh/KnownHostsPanel";
import { SECTION_HINT, SECTION_LABEL } from "./controls";

export function SshSettings() {
  const t = useT();
  return (
    <div style={{ color: "var(--c-text-3)", fontSize: "var(--fs-body)" }}>
      <div style={SECTION_LABEL}>{t("known_hosts.title")}</div>
      <div style={{ ...SECTION_HINT, marginBottom: 14 }}>{t("settings.ssh.known_hosts.hint")}</div>
      <KnownHostsPanel />
    </div>
  );
}
