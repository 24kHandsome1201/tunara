import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm as tauriConfirmDialog } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { consumePendingSettingsSection, useUIStore } from "@/state/ui";
import { useT } from "@/modules/i18n";
import { CloseIcon } from "../shared";
import { FileIcon } from "../icons";
import { AppSettings } from "./settings/AppSettings";
import { AppearanceSettings } from "./settings/AppearanceSettings";
import { CliSettings } from "./settings/CliSettings";
import { DefaultFolderSetting } from "./settings/DefaultFolderSetting";
import { EverydayAppearance } from "./settings/EverydayAppearance";
import { SshSettings } from "./settings/SshSettings";
import { TerminalSettings } from "./settings/TerminalSettings";
import { useCliStatus } from "./settings/useCliStatus";
import { useAppUpdate } from "./useAppUpdate";
import { Modal, MODAL_COLUMN_LAYOUT } from "./Modal";

const advancedSections = ["appearance-options", "terminal", "ssh", "advanced", "about"] as const;

function SettingsSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={`settings-section-${id}`} className="settings-details-section" tabIndex={-1} aria-label={title}>
      <h2 className="settings-layout-heading">{title}</h2>
      {children}
    </section>
  );
}

function AdvancedSettings() {
  const t = useT();
  const cliStatus = useCliStatus();
  const appUpdate = useAppUpdate();
  const [resetOverridesError, setResetOverridesError] = useState(false);

  return (
    <>
      <SettingsSection id="appearance-options" title={t("settings.advanced.appearance")}>
        <AppearanceSettings />
      </SettingsSection>
      <SettingsSection id="terminal" title={t("settings.section.terminal")}>
        <TerminalSettings />
      </SettingsSection>
      <SettingsSection id="ssh" title={t("settings.section.ssh")}>
        <SshSettings />
      </SettingsSection>
      <SettingsSection id="advanced" title={t("settings.advanced.cli")}>
        <CliSettings {...cliStatus} />
        <button
          type="button"
          onClick={async () => {
            const ok = await tauriConfirmDialog(t("settings.cli.reset_overrides.confirm"), { kind: "warning" });
            if (!ok) return;
            setResetOverridesError(false);
            try {
              await invoke("clear_bin_overrides");
              cliStatus.loadCliStatus();
            } catch {
              setResetOverridesError(true);
            }
          }}
          className="settings-action-button settings-row-action hover-bg"
          style={{ marginTop: 12 }}
        >
          {t("settings.cli.reset_overrides")}
        </button>
        {resetOverridesError && <p className="settings-row-error" role="alert">{t("settings.cli.reset_overrides.error")}</p>}
      </SettingsSection>
      <SettingsSection id="about" title={t("settings.section.about")}>
        <AppSettings {...appUpdate} />
      </SettingsSection>
    </>
  );
}

export function Settings({ onClose }: { onClose: () => void }) {
  const t = useT();
  const configPath = useUIStore((s) => s.configPath);
  const configError = useUIStore((s) => s.configError);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [openConfigError, setOpenConfigError] = useState(false);
  const [section, setSection] = useState<string | null>(null);

  useEffect(() => {
    const target = consumePendingSettingsSection();
    if (!target) return;
    if (advancedSections.some((id) => id === target)) setAdvancedOpen(true);
    setSection(target);
  }, []);

  useEffect(() => {
    if (!section) return;
    const target = document.getElementById(`settings-section-${section}`);
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "start" });
    setSection(null);
  }, [section]);

  return (
    <Modal labelledBy="settings-title" onRequestClose={onClose} initialFocus="container" className="settings-dialog" style={{ ...MODAL_COLUMN_LAYOUT, width: 860, maxWidth: "calc(100vw - 32px)" }}>
      <div className="settings-dialog-header">
        <div>
          <h1 id="settings-title">{t("settings.title")}</h1>
          <p className="settings-layout-hint">{t("settings.everyday.subtitle")}</p>
        </div>
        <button type="button" onClick={onClose} aria-label={t("common.close")} className="settings-close hover-bg">
          <CloseIcon size={13} strokeWidth={2.2} />
        </button>
      </div>

      <div id="settings-tabpanel" className="scroll-fade-y">
        <EverydayAppearance />
        <DefaultFolderSetting />
        <section className="settings-everyday-row" aria-labelledby="settings-shortcuts-title">
          <div>
            <h2 id="settings-shortcuts-title" className="settings-layout-label">{t("settings.everyday.shortcuts")}</h2>
            <p className="settings-layout-hint">{t("settings.config.shortcuts_hint")}</p>
            {configError && <p role="alert" title={configError} className="settings-row-error">{t("settings.config_error")}</p>}
            {openConfigError && <p role="alert" className="settings-row-error">{t("settings.config.open_error")}</p>}
          </div>
          <button
            type="button"
            disabled={!configPath}
            title={configPath || undefined}
            onClick={async () => {
              if (!configPath) return;
              setOpenConfigError(false);
              try {
                await openPath(configPath);
              } catch {
                setOpenConfigError(true);
              }
            }}
            className="settings-action-button settings-row-action hover-bg"
          >
            <FileIcon size={14} />
            {t("settings.everyday.open_config")}
          </button>
        </section>

        <button
          type="button"
          className="settings-advanced-summary"
          aria-expanded={advancedOpen}
          aria-controls="settings-advanced-panel"
          aria-labelledby="settings-advanced-title"
          aria-describedby="settings-advanced-hint"
          onClick={() => setAdvancedOpen(!advancedOpen)}
        >
          <svg aria-hidden="true" className="settings-advanced-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeLinecap="round">
            <path d="M2 5h12M2 11h12M6 3v4m4 2v4" />
          </svg>
          <span>
            <strong id="settings-advanced-title">{t("settings.section.advanced")}</strong>
            <span id="settings-advanced-hint" className="settings-layout-hint">{t("settings.everyday.advanced_hint")}</span>
          </span>
          <span aria-hidden="true" className="settings-advanced-chevron" />
        </button>
        <div id="settings-advanced-panel" hidden={!advancedOpen}>
          <AdvancedSettings />
        </div>
      </div>

      <div className="settings-dialog-footer">
        <kbd className="settings-key-hint">{t("common.escape")}</kbd>
        <button type="button" onClick={onClose} className="settings-done hover-primary">{t("common.done")}</button>
      </div>
    </Modal>
  );
}
