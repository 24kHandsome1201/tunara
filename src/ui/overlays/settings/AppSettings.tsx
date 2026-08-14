import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { confirm as tauriConfirmDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useT } from "@/modules/i18n";
import type { useAppUpdate } from "../useAppUpdate";
import { SECTION_LABEL, SECTION_HINT } from "./controls";

type LegacyAgentDataState = "loading" | "missing" | "present" | "deleting" | "error";

/** The update flow state stays in the dialog shell (useAppUpdate) so an
 * in-progress download survives tab switches; this tab only renders it. */
type AppUpdateState = ReturnType<typeof useAppUpdate>;

/** App tab: version, signed updater flow, and legacy Agent data cleanup. */
export function AppSettings({ appVersion, updateStatus, updateVersion, updateProgress, canInstallUpdate, checkForUpdates, installUpdate }: AppUpdateState) {
  const t = useT();
  const [legacyAgentDataState, setLegacyAgentDataState] = useState<LegacyAgentDataState>("loading");
  const updateBusy = updateStatus === "checking" || updateStatus === "downloading" || updateStatus === "restarting";

  const loadLegacyAgentDataStatus = useCallback(() => {
    setLegacyAgentDataState("loading");
    invoke<"missing" | "present">("legacy_agent_data_status")
      .then(setLegacyAgentDataState)
      .catch(() => setLegacyAgentDataState("error"));
  }, []);

  // This tab is only mounted while active, so mount = tab opened.
  useEffect(() => {
    loadLegacyAgentDataStatus();
  }, [loadLegacyAgentDataStatus]);

  const deleteLegacyAgentData = useCallback(async () => {
    const confirmed = await tauriConfirmDialog(t("settings.app.legacy_agent_data.confirm"), { kind: "warning" });
    if (!confirmed) return;
    setLegacyAgentDataState("deleting");
    invoke<"missing">("legacy_agent_data_delete", { confirmed: true })
      .then(() => setLegacyAgentDataState("missing"))
      .catch(() => setLegacyAgentDataState("error"));
  }, [t]);

  return (
    <div style={{ color: "var(--c-text-3)", fontSize: "var(--fs-body)" }}>
      <div style={{ paddingBottom: 20, borderBottom: "1px solid var(--c-border-1)" }}>
        <div style={SECTION_LABEL}>{t("settings.app.version")}</div>
        <div style={{ fontFamily: "var(--font-mono)", color: "var(--c-text-primary)", fontSize: "var(--fs-title)", fontWeight: 600 }}>
          Tunara {appVersion ? `v${appVersion}` : ""}
        </div>
      </div>
      <div style={{ paddingTop: 20 }}>
        <div style={SECTION_LABEL}>{t("settings.app.updates")}</div>
        <div style={{ ...SECTION_HINT, marginBottom: 14 }}>{t("settings.app.updates.hint")}</div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 16,
            padding: "12px 0",
            borderTop: "1px solid var(--c-border-1)",
            borderBottom: "1px solid var(--c-border-1)",
            background: updateStatus === "error" ? "var(--c-error-bg)" : "transparent",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ color: updateStatus === "error" ? "var(--c-error)" : "var(--c-text-primary)", fontWeight: 600, marginBottom: 3 }}>
              {updateStatus === "checking" ? t("settings.app.updates.checking")
                : updateStatus === "current" ? t("settings.app.updates.current")
                : updateStatus === "available" || updateStatus === "downloading" || updateStatus === "restarting" ? t("settings.app.updates.available", { version: updateVersion })
                : updateStatus === "error" ? t("settings.app.updates.error")
                : t("settings.app.updates.ready")}
            </div>
            {(updateStatus === "downloading" || updateStatus === "restarting") && (
              <div style={{ color: "var(--c-text-4)", fontSize: "var(--fs-meta)" }}>
                {updateStatus === "restarting"
                  ? t("settings.app.updates.restarting")
                  : updateProgress === null
                    ? t("settings.app.updates.downloading")
                    : t("settings.app.updates.progress", { progress: updateProgress })}
              </div>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 7, flexShrink: 0 }}>
            {updateStatus === "error" && (
              <button
                onClick={() => { void openUrl("https://github.com/24kHandsome1201/tunara/releases/latest"); }}
                className="hover-bg"
                style={{ padding: "7px 10px", borderRadius: "var(--r-btn)", border: "1px solid var(--c-border-2)", background: "var(--c-bg-white)", color: "var(--c-text-3)", fontSize: "var(--fs-secondary)", fontWeight: 600, cursor: "pointer" }}
              >
                {t("settings.app.updates.open_releases")}
              </button>
            )}
            <button
              onClick={() => { void (canInstallUpdate ? installUpdate() : checkForUpdates()); }}
              disabled={updateBusy}
              className={canInstallUpdate ? "hover-primary" : "hover-bg"}
              style={{ padding: "7px 12px", borderRadius: "var(--r-btn)", border: canInstallUpdate ? "none" : "1px solid var(--c-border-2)", background: canInstallUpdate ? "var(--c-btn-primary-bg)" : "var(--c-bg-white)", color: canInstallUpdate ? "var(--c-btn-primary-text)" : "var(--c-text-2)", fontSize: "var(--fs-secondary)", fontWeight: 600, cursor: updateBusy ? "wait" : "pointer" }}
            >
              {canInstallUpdate ? t("settings.app.updates.install") : updateStatus === "error" ? t("settings.app.updates.retry") : t("settings.app.updates.check")}
            </button>
          </div>
        </div>
      </div>
      {(legacyAgentDataState === "present" || legacyAgentDataState === "deleting" || legacyAgentDataState === "error") && (
        <div style={{ paddingTop: 20 }} aria-live="polite">
          <div style={SECTION_LABEL}>{t("settings.app.legacy_agent_data.title")}</div>
          {legacyAgentDataState === "error" ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
              <div style={{ ...SECTION_HINT, color: "var(--c-error)", marginBottom: 0 }}>
                {t("settings.app.legacy_agent_data.error")}
              </div>
              <button
                onClick={loadLegacyAgentDataStatus}
                className="hover-bg"
                style={{ padding: "7px 12px", borderRadius: "var(--r-btn)", border: "1px solid var(--c-border-2)", background: "var(--c-bg-white)", color: "var(--c-text-2)", fontSize: "var(--fs-secondary)", fontWeight: 600, cursor: "pointer", flexShrink: 0 }}
              >
                {t("settings.app.legacy_agent_data.retry")}
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
              <div style={{ ...SECTION_HINT, marginBottom: 0 }}>
                {t("settings.app.legacy_agent_data.hint")}
              </div>
              <button
                onClick={() => { void deleteLegacyAgentData(); }}
                disabled={legacyAgentDataState === "deleting"}
                className="hover-bg"
                style={{ padding: "7px 12px", borderRadius: "var(--r-btn)", border: "1px solid var(--c-error)", background: "transparent", color: "var(--c-error)", fontSize: "var(--fs-secondary)", fontWeight: 600, cursor: legacyAgentDataState === "deleting" ? "wait" : "pointer", flexShrink: 0 }}
              >
                {legacyAgentDataState === "deleting"
                  ? t("settings.app.legacy_agent_data.deleting")
                  : t("settings.app.legacy_agent_data.delete")}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
