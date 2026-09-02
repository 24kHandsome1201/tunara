import { useUIStore, type ExternalEditor, EXTERNAL_EDITORS, EDITOR_LABELS } from "@/state/ui";
import { useT } from "@/modules/i18n";
import {
  SECTION_HINT,
  SECTION_LABEL,
  Segmented,
  ToggleRow,
} from "./controls";
import { AccessibilitySettings } from "./AccessibilitySettings";

/** Terminal: host modifier, clipboard, bell, editor, accessibility. */
export function TerminalSettings() {
  const t = useT();
  const bellNotification = useUIStore((s) => s.bellNotification);
  const setBellNotification = useUIStore((s) => s.setBellNotification);
  const terminalClipboardWrite = useUIStore((s) => s.terminalClipboardWrite);
  const setTerminalClipboardWrite = useUIStore((s) => s.setTerminalClipboardWrite);
  const terminalHostModifier = useUIStore((s) => s.terminalHostModifier);
  const setTerminalHostModifier = useUIStore((s) => s.setTerminalHostModifier);
  const externalEditor = useUIStore((s) => s.externalEditor);
  const setExternalEditor = useUIStore((s) => s.setExternalEditor);

  return (
    <div>
      <div className="settings-terminal-interactions" style={{ marginBottom: 24 }}>
        <label htmlFor="terminal-host-modifier" className="settings-interaction-row" style={{ display: "grid", gridTemplateColumns: "minmax(150px, 1fr) minmax(210px, auto)", alignItems: "center", gap: 10, fontSize: "var(--fs-secondary)" }}>
          <span>{t("settings.appearance.host_modifier")}</span>
          <select
            id="terminal-host-modifier"
            className="settings-control"
            value={terminalHostModifier}
            onChange={(event) => setTerminalHostModifier(event.target.value as "shift" | "meta" | "alt")}
          >
            <option value="shift">Shift</option>
            <option value="meta">Cmd/Meta</option>
            <option value="alt">Alt/Option</option>
          </select>
        </label>
        <div style={SECTION_HINT}>{t("settings.appearance.host_modifier.hint")}</div>
      </div>
      <ToggleRow label={t("settings.appearance.bell_notification")} hint={t("settings.appearance.bell_notification.hint")} checked={bellNotification} onChange={setBellNotification} />
      <ToggleRow label={t("settings.appearance.clipboard_write")} hint={t("settings.appearance.clipboard_write.hint")} checked={terminalClipboardWrite} onChange={() => setTerminalClipboardWrite(!terminalClipboardWrite)} />
      <div style={{ marginTop: 24, marginBottom: 24 }}>
        <div style={SECTION_LABEL}>{t("settings.appearance.external_editor")}</div>
        <Segmented
          ariaLabel={t("settings.appearance.external_editor")}
          options={EXTERNAL_EDITORS.map((ed: ExternalEditor) => ({ id: ed, label: EDITOR_LABELS[ed] }))}
          value={externalEditor}
          onChange={setExternalEditor}
        />
      </div>
      <AccessibilitySettings />
    </div>
  );
}
