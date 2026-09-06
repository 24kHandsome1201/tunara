import { useT } from "@/modules/i18n";
import { KnownHostsPanel } from "@/modules/ssh/KnownHostsPanel";
import { useUIStore } from "@/state/ui";
import { SECTION_HINT, SECTION_LABEL, Stepper } from "./controls";

export function SshSettings() {
  const t = useT();
  const downloadMaxFiles = useUIStore((s) => s.downloadMaxFiles);
  const downloadMaxFileBytes = useUIStore((s) => s.downloadMaxFileBytes);
  const downloadMaxTotalBytes = useUIStore((s) => s.downloadMaxTotalBytes);
  const setDownloadLimits = useUIStore((s) => s.setDownloadLimits);
  return (
    <div style={{ color: "var(--c-text-3)", fontSize: "var(--fs-body)" }}>
      <div style={{ marginBottom: 24 }}>
        <div style={SECTION_LABEL}>{t("known_hosts.title")}</div>
        <div style={{ ...SECTION_HINT, marginBottom: 14 }}>{t("settings.ssh.known_hosts.hint")}</div>
        <KnownHostsPanel />
      </div>
      <div style={{ paddingTop: 20, borderTop: "1px solid var(--c-border-1)" }}>
        <div style={SECTION_LABEL}>{t("settings.transfers.title")}</div>
        <div style={{ ...SECTION_HINT, marginBottom: 14 }}>{t("settings.transfers.hint")}</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 14 }}>
          {([
            [t("settings.transfers.max_files"), `${downloadMaxFiles}`, () => setDownloadLimits({ maxFiles: Math.max(1, downloadMaxFiles - 10) }), () => setDownloadLimits({ maxFiles: Math.min(10_000, downloadMaxFiles + 10) })],
            [t("settings.transfers.max_file_mib"), `${Math.round(downloadMaxFileBytes / (1024 ** 2))}`, () => setDownloadLimits({ maxFileBytes: Math.max(1024 ** 2, downloadMaxFileBytes - 10 * 1024 ** 2) }), () => setDownloadLimits({ maxFileBytes: Math.min(1024 ** 3, downloadMaxFileBytes + 10 * 1024 ** 2) })],
            [t("settings.transfers.max_total_gib"), `${(downloadMaxTotalBytes / (1024 ** 3)).toFixed(1)}`, () => setDownloadLimits({ maxTotalBytes: Math.max(1024 ** 3, downloadMaxTotalBytes - 1024 ** 3) }), () => setDownloadLimits({ maxTotalBytes: Math.min(10 * 1024 ** 3, downloadMaxTotalBytes + 1024 ** 3) })],
          ] satisfies [string, string, () => void, () => void][]).map(([label, display, decrement, increment]) => (
            <div key={label}>
              <div style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-4)", marginBottom: 6 }}>{label}</div>
              <Stepper display={display} valueMinWidth={48} decrementLabel={`${t("common.decrement")} · ${label}`} incrementLabel={`${t("common.increment")} · ${label}`} onDecrement={decrement} onIncrement={increment} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
