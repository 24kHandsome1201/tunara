import { useUIStore } from "@/state/ui";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useT } from "@/modules/i18n";
import {
  IS_MAC,
  SECTION_HINT,
  SECTION_LABEL_INLINE,
  ToggleRow,
  TOGGLE_ROW,
} from "./controls";

/** Screen reader and OS privacy affordances. */
export function AccessibilitySettings() {
  const t = useT();
  const terminalScreenReaderMode = useUIStore((s) => s.terminalScreenReaderMode);
  const setTerminalScreenReaderMode = useUIStore((s) => s.setTerminalScreenReaderMode);

  return (
    <div>
      <ToggleRow
        label={t("settings.appearance.screen_reader_mode")}
        hint={t("settings.appearance.screen_reader_mode.hint")}
        checked={terminalScreenReaderMode}
        onChange={setTerminalScreenReaderMode}
      />
      {IS_MAC && (
        <div style={{ marginBottom: 24 }}>
          <div style={TOGGLE_ROW}>
            <span style={SECTION_LABEL_INLINE}>{t("settings.privacy.title")}</span>
            <button
              onClick={() => {
                openUrl("x-apple.systempreferences:com.apple.preference.security?Privacy_Files").catch(() => {});
              }}
              style={{
                height: 28, padding: "0 12px", borderRadius: "var(--r-btn)",
                border: "1px solid var(--c-border-2)", background: "var(--c-bg-white)",
                color: "var(--c-text-2)", fontSize: "var(--fs-secondary)",
                fontWeight: 500, cursor: "pointer", flexShrink: 0,
              }}
            >
              {t("settings.privacy.open_system")}
            </button>
          </div>
          <div style={SECTION_HINT}>{t("settings.privacy.hint")}</div>
        </div>
      )}
    </div>
  );
}
