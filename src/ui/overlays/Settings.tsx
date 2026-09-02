import { useEffect, type CSSProperties, type ReactNode } from "react";
import { useUIStore, consumePendingSettingsSection } from "@/state/ui";
import { invoke } from "@tauri-apps/api/core";
import { confirm as tauriConfirmDialog } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { CloseIcon } from "../shared";
import { useT } from "@/modules/i18n";
import { useAppUpdate } from "./useAppUpdate";
import { AppearanceSettings } from "./settings/AppearanceSettings";
import { TerminalSettings } from "./settings/TerminalSettings";
import { CliSettings } from "./settings/CliSettings";
import { AppSettings } from "./settings/AppSettings";
import { SshSettings } from "./settings/SshSettings";
import { useCliStatus } from "./settings/useCliStatus";
import { SECTION_HINT, SECTION_LABEL } from "./settings/controls";
import { Modal } from "./Modal";

interface SettingsProps {
  onClose: () => void;
}

function SettingsSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={`settings-section-${id}`} style={{ marginBottom: 32 }}>
      <h2 className="settings-section-title" style={{ fontSize: "var(--fs-body)", fontWeight: 700, color: "var(--c-text-primary)", margin: "0 0 14px" }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

/**
 * Single-page settings dialog: chrome (backdrop, focus trap, footer) plus
 * the per-dialog state that must survive while the overlay is open (update
 * download, CLI probes). Sections live in ./settings and subscribe to their
 * own slices.
 */
export function Settings({ onClose }: SettingsProps) {
  const t = useT();
  const configPath = useUIStore((s) => s.configPath);
  const configError = useUIStore((s) => s.configError);

  const appUpdate = useAppUpdate();
  const cliStatus = useCliStatus();

  useEffect(() => {
    const section = consumePendingSettingsSection();
    if (!section) return;
    document.getElementById(`settings-section-${section}`)?.scrollIntoView({ block: "start" });
  }, []);

  const footerButtonStyle: CSSProperties = { padding: "6px 14px", borderRadius: "var(--r-btn)", border: "1px solid var(--c-border-2)", background: "transparent", color: "var(--c-text-4)", fontSize: "var(--fs-secondary)", cursor: "pointer" };
  const actionButtonStyle: CSSProperties = { height: 30, padding: "0 12px", borderRadius: "var(--r-btn)", border: "1px solid var(--c-border-2)", background: "var(--c-bg-white)", color: "var(--c-text-2)", fontSize: "var(--fs-secondary)", fontWeight: 500, cursor: "pointer", flexShrink: 0 };

  return (
    <Modal
      labelledBy="settings-title"
      onRequestClose={onClose}
      initialFocus="container"
      backdropZIndex={200}
      zIndex={201}
      className="settings-dialog"
      style={{ width: 620, maxWidth: "calc(100vw - 32px)", overflow: "hidden", display: "flex", flexDirection: "column", height: "min(82dvh, 760px)", maxHeight: "min(82dvh, 760px)" }}
    >
        <div className="settings-dialog-header">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span id="settings-title" style={{ fontSize: "var(--fs-title)", fontWeight: 700, color: "var(--c-text-primary)" }}>{t("settings.title")}</span>
            <button onClick={onClose} aria-label={t("common.close")} style={{ width: 26, height: 26, border: "none", background: "transparent", cursor: "pointer", color: "var(--c-text-4)", borderRadius: "var(--r-btn)", display: "flex", alignItems: "center", justifyContent: "center" }} className="hover-bg">
              <CloseIcon size={13} strokeWidth={2.2} />
            </button>
          </div>
        </div>

        <div id="settings-tabpanel" className="no-scrollbar scroll-fade-y">
          <SettingsSection id="appearance" title={t("settings.section.appearance")}>
            <AppearanceSettings />
          </SettingsSection>
          <SettingsSection id="terminal" title={t("settings.section.terminal")}>
            <TerminalSettings />
          </SettingsSection>
          <SettingsSection id="ssh" title={t("settings.section.ssh")}>
            <SshSettings />
          </SettingsSection>
          <SettingsSection id="about" title={t("settings.section.about")}>
            <AppSettings {...appUpdate} />
            <div style={{ marginTop: 22, paddingTop: 18, borderTop: "1px solid var(--c-border-1)" }}>
              <CliSettings {...cliStatus} />
              <button
                onClick={async () => {
                  const ok = await tauriConfirmDialog(t("settings.cli.reset_overrides.confirm"), { kind: "warning" });
                  if (!ok) return;
                  invoke("clear_bin_overrides")
                    .then(() => cliStatus.loadCliStatus())
                    .catch(() => {});
                }}
                style={{ ...footerButtonStyle, marginTop: 12 }}
                className="hover-bg settings-action-button"
              >
                {t("settings.cli.reset_overrides")}
              </button>
            </div>
            <div style={{ marginTop: 22, paddingTop: 18, borderTop: "1px solid var(--c-border-1)" }}>
              <div style={SECTION_LABEL}>{t("settings.config.path")}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                {configError ? (
                  <span title={configError} style={{ fontSize: "var(--fs-meta)", color: "var(--c-error)", fontFamily: "var(--font-mono)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t("settings.config_error")}</span>
                ) : configPath ? (
                  <span title={configPath} style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{configPath}</span>
                ) : (
                  <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", flex: 1 }} />
                )}
                <button
                  type="button"
                  disabled={!configPath}
                  onClick={() => { if (configPath) void openPath(configPath); }}
                  className="hover-bg settings-action-button"
                  style={{ ...actionButtonStyle, opacity: configPath ? 1 : 0.55, cursor: configPath ? "pointer" : "default" }}
                >
                  {t("settings.config.open")}
                </button>
              </div>
              <div style={{ ...SECTION_HINT, marginTop: 8 }}>{t("settings.config.shortcuts_hint")}</div>
            </div>
          </SettingsSection>
        </div>

        <div className="settings-dialog-footer">
          <button
            onClick={async () => {
              const ok = await tauriConfirmDialog(t("settings.appearance.reset_confirm"), { kind: "warning" });
              if (!ok) return;
              useUIStore.getState().resetAppearance();
            }}
            style={footerButtonStyle}
            className="hover-bg settings-action-button"
          >
            {t("common.reset_defaults")}
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            <kbd className="settings-key-hint" style={{ padding: "2px 6px" }}>{t("common.escape")}</kbd>
            <button onClick={onClose} className="hover-primary" style={{ padding: "6px 18px", borderRadius: "var(--r-btn)", border: "none", background: "var(--c-btn-primary-bg)", color: "var(--c-btn-primary-text)", fontSize: "var(--fs-body)", fontWeight: 500, cursor: "pointer", transition: "opacity var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out)" }}>
              {t("common.done")}
            </button>
          </div>
        </div>
    </Modal>
  );
}
