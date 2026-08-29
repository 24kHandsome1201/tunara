import { useUIStore, type SettingsTab } from "@/state/ui";
import { invoke } from "@tauri-apps/api/core";
import { confirm as tauriConfirmDialog } from "@tauri-apps/plugin-dialog";
import { CloseIcon } from "../shared";
import { useT } from "@/modules/i18n";
import { useAppUpdate } from "./useAppUpdate";
import { useWorkflowsStore } from "@/state/workflows";
import { focusTabById, resolveRovingTabId, tabIdFromEventTarget } from "../lib/tab-list-navigation";
import { AppearanceSettings } from "./settings/AppearanceSettings";
import { TerminalSettings } from "./settings/TerminalSettings";
import { AccessibilitySettings } from "./settings/AccessibilitySettings";
import { ShortcutsSettings } from "./settings/ShortcutsSettings";
import { WorkflowsSettings } from "./settings/WorkflowsSettings";
import { CliSettings } from "./settings/CliSettings";
import { AppSettings } from "./settings/AppSettings";
import { SshSettings } from "./settings/SshSettings";
import { useCliStatus } from "./settings/useCliStatus";
import { Modal } from "./Modal";

interface SettingsProps {
  onClose: () => void;
}

const TABS = ["appearance", "terminal", "accessibility", "shortcuts", "workflows", "cli", "ssh", "app"] as const;

/**
 * Settings dialog shell: chrome (backdrop, focus trap, tab list, footer) plus
 * the per-dialog state that must survive tab switches (update download, CLI
 * probes). Tab panels live in ./settings and subscribe to their own slices.
 */
export function Settings({ onClose }: SettingsProps) {
  const t = useT();
  const activeTab = useUIStore((s) => s.settingsTab);
  const setActiveTab = useUIStore((s) => s.setSettingsTab);
  const configPath = useUIStore((s) => s.configPath);
  const configError = useUIStore((s) => s.configError);

  // Subscribe to the workflow count so the footer "clear all" button's
  // disabled state stays reactive (getState() in render wouldn't re-render
  // when workflows change, leaving the button enabled after a clear).
  const workflowCount = useWorkflowsStore((s) => s.workflows.length);
  const appUpdate = useAppUpdate(activeTab);
  const cliStatus = useCliStatus(activeTab);

  // APG tabs 键盘漫游（自动激活）：方向键/Home/End 在设置页签间循环
  const handleTabListKeyDown = (e: React.KeyboardEvent) => {
    const currentId = tabIdFromEventTarget(e.target);
    if (!currentId) return;
    const nextId = resolveRovingTabId(TABS, currentId, e.key);
    if (!nextId || nextId === currentId) return;
    e.preventDefault();
    setActiveTab(nextId as SettingsTab);
    focusTabById(e.currentTarget as HTMLElement, nextId);
  };

  const footerButtonStyle: React.CSSProperties = { padding: "6px 14px", borderRadius: "var(--r-btn)", border: "1px solid var(--c-border-2)", background: "transparent", color: "var(--c-text-4)", fontSize: "var(--fs-secondary)", cursor: "pointer" };

  return (
    <Modal
      labelledBy="settings-title"
      onRequestClose={onClose}
      initialFocus="container"
      backdropZIndex={200}
      zIndex={201}
      className="settings-dialog"
      style={{ width: 620, maxWidth: "calc(100vw - 32px)", overflow: "hidden", display: "flex", flexDirection: "column", height: "min(82dvh, 760px)", maxHeight: "min(82dvh, 760px)", animation: "sheetIn var(--duration-normal) var(--ease-out-back)" }}
    >
        <div className="settings-dialog-header">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <span id="settings-title" style={{ fontSize: "var(--fs-title)", fontWeight: 700, color: "var(--c-text-primary)" }}>{t("settings.title")}</span>
            <button onClick={onClose} aria-label={t("common.close")} style={{ width: 26, height: 26, border: "none", background: "transparent", cursor: "pointer", color: "var(--c-text-4)", borderRadius: "var(--r-btn)", display: "flex", alignItems: "center", justifyContent: "center" }} className="hover-bg">
              <CloseIcon size={13} strokeWidth={2.2} />
            </button>
          </div>
          <div
            className="no-scrollbar"
            role="tablist"
            aria-label={t("settings.title")}
            onKeyDown={handleTabListKeyDown}
            style={{ display: "flex", gap: 12, borderBottom: "1px solid var(--c-border-1)", overflowX: "auto", overscrollBehaviorX: "contain", scrollSnapType: "x proximity" }}
          >
            {TABS.map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                role="tab"
                aria-selected={activeTab === tab}
                aria-controls="settings-tabpanel"
                data-tab-id={tab}
                tabIndex={activeTab === tab ? 0 : -1}
                data-active={activeTab === tab ? "true" : "false"}
                className="settings-tab-pill"
                style={{ padding: "5px 0 8px", marginBottom: -1, border: "none", background: "transparent", color: activeTab === tab ? "var(--c-text-primary)" : "var(--c-text-4)", fontSize: "var(--fs-body)", fontWeight: activeTab === tab ? 600 : 400, cursor: "pointer", transition: "color var(--duration-fast) var(--ease-smooth)", whiteSpace: "nowrap", flexShrink: 0, scrollSnapAlign: "start" }}
              >
                {t(`settings.tabs.${tab}`)}
              </button>
            ))}
          </div>
        </div>

        <div role="tabpanel" id="settings-tabpanel" className="no-scrollbar scroll-fade-y">
          {activeTab === "appearance" && <AppearanceSettings />}
          {activeTab === "terminal" && <TerminalSettings />}
          {activeTab === "accessibility" && <AccessibilitySettings />}
          {activeTab === "shortcuts" && <ShortcutsSettings />}
          {activeTab === "workflows" && <WorkflowsSettings />}
          {activeTab === "cli" && <CliSettings {...cliStatus} />}
          {activeTab === "ssh" && <SshSettings />}
          {activeTab === "app" && <AppSettings {...appUpdate} />}
        </div>

        <div className="settings-dialog-footer">
          {activeTab === "appearance" || activeTab === "terminal" || activeTab === "accessibility" ? (
            <button
              onClick={async () => {
                const ok = await tauriConfirmDialog(t("settings.appearance.reset_confirm"), { kind: "warning" });
                if (!ok) return;
                useUIStore.getState().resetAppearance();
              }}
              style={footerButtonStyle}
              className="hover-bg"
            >
              {t("common.reset_defaults")}
            </button>
          ) : activeTab === "workflows" ? (
            <button
              onClick={async () => {
                // wry's WKWebView renders no JS dialog UI, so use the Tauri
                // dialog plugin (the paste-protection confirmer uses it too).
                const ok = await tauriConfirmDialog(t("settings.workflows.clear_all.confirm"), { kind: "warning" });
                if (!ok) return;
                const workflows = useWorkflowsStore.getState().workflows;
                for (const w of workflows) useWorkflowsStore.getState().removeWorkflow(w.id);
              }}
              disabled={workflowCount === 0}
              style={footerButtonStyle}
              className="hover-bg"
            >
              {t("settings.workflows.clear_all")}
            </button>
          ) : activeTab === "cli" ? (
            <button
              onClick={async () => {
                const ok = await tauriConfirmDialog(t("settings.cli.reset_overrides.confirm"), { kind: "warning" });
                if (!ok) return;
                invoke("clear_bin_overrides")
                  .then(() => cliStatus.loadCliStatus())
                  .catch(() => {});
              }}
              style={footerButtonStyle}
              className="hover-bg"
            >
              {t("settings.cli.reset_overrides")}
            </button>
          ) : <span />}
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            {configError ? (
              <span title={configError} style={{ fontSize: "var(--fs-meta)", color: "var(--c-error)", fontFamily: "var(--font-mono)", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t("settings.config_error")}</span>
            ) : configPath ? (
              <span title={configPath} style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{configPath}</span>
            ) : null}
            <kbd className="settings-key-hint" style={{ padding: "2px 6px" }}>{t("common.escape")}</kbd>
            <button onClick={onClose} className="hover-primary" style={{ padding: "6px 18px", borderRadius: "var(--r-btn)", border: "none", background: "var(--c-btn-primary-bg)", color: "var(--c-btn-primary-text)", fontSize: "var(--fs-body)", fontWeight: 500, cursor: "pointer", transition: "opacity var(--duration-fast) var(--ease-smooth), transform var(--duration-fast) var(--ease-out-expo)" }}>
              {t("common.done")}
            </button>
          </div>
        </div>
    </Modal>
  );
}
