import { useEffect, useState } from "react";
import { useUIStore, type CursorStyle, type ExternalEditor, EXTERNAL_EDITORS, EDITOR_LABELS } from "@/state/ui";
import { useT } from "@/modules/i18n";
import {
  SECTION_HINT,
  SECTION_LABEL,
  SECTION_LABEL_INLINE,
  Segmented,
  Stepper,
  Toggle,
  ToggleRow,
  TOGGLE_ROW,
} from "./controls";

function CursorStylePicker({ value, onChange }: { value: CursorStyle; onChange: (v: CursorStyle) => void }) {
  const t = useT();
  return (
    <Segmented
      ariaLabel={t("settings.appearance.cursor_style")}
      options={[
        { id: "bar", label: t("settings.appearance.cursor.bar") },
        { id: "block", label: t("settings.appearance.cursor.block") },
        { id: "underline", label: t("settings.appearance.cursor.underline") },
      ]}
      value={value}
      onChange={onChange}
    />
  );
}

/** Terminal tab: cursor, fonts, scrollback, clipboard, and editor. */
export function TerminalSettings() {
  const t = useT();
  const cursorStyle = useUIStore((s) => s.cursorStyle);
  const setCursorStyle = useUIStore((s) => s.setCursorStyle);
  const cursorBlink = useUIStore((s) => s.cursorBlink);
  const setCursorBlink = useUIStore((s) => s.setCursorBlink);
  const fontSize = useUIStore((s) => s.fontSize);
  const setFontSize = useUIStore((s) => s.setFontSize);
  const fontFamily = useUIStore((s) => s.fontFamily);
  const setFontFamily = useUIStore((s) => s.setFontFamily);
  const fontLigatures = useUIStore((s) => s.fontLigatures);
  const setFontLigatures = useUIStore((s) => s.setFontLigatures);
  const nerdFontFallback = useUIStore((s) => s.nerdFontFallback);
  const setNerdFontFallback = useUIStore((s) => s.setNerdFontFallback);
  const scrollback = useUIStore((s) => s.scrollback);
  const setScrollback = useUIStore((s) => s.setScrollback);
  const bellNotification = useUIStore((s) => s.bellNotification);
  const setBellNotification = useUIStore((s) => s.setBellNotification);
  const terminalClipboardWrite = useUIStore((s) => s.terminalClipboardWrite);
  const setTerminalClipboardWrite = useUIStore((s) => s.setTerminalClipboardWrite);
  const terminalInlineImages = useUIStore((s) => s.terminalInlineImages);
  const setTerminalInlineImages = useUIStore((s) => s.setTerminalInlineImages);
  const showPureModeFilesButton = useUIStore((s) => s.showPureModeFilesButton);
  const setShowPureModeFilesButton = useUIStore((s) => s.setShowPureModeFilesButton);
  const externalEditor = useUIStore((s) => s.externalEditor);
  const setExternalEditor = useUIStore((s) => s.setExternalEditor);

  const [fontDraft, setFontDraft] = useState(fontFamily);
  useEffect(() => { setFontDraft(fontFamily); }, [fontFamily]);

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <div style={TOGGLE_ROW}>
          <span style={SECTION_LABEL_INLINE}>{t("settings.appearance.cursor_style")}</span>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <span style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-4)" }}>{t("settings.appearance.cursor_blink")}</span>
            <Toggle checked={cursorBlink} onChange={setCursorBlink} ariaLabel={t("settings.appearance.cursor_blink")} />
          </label>
        </div>
        <CursorStylePicker value={cursorStyle} onChange={setCursorStyle} />
      </div>
      <div style={{ marginBottom: 24 }}>
        <div style={SECTION_LABEL}>{t("settings.appearance.font_size")}</div>
        <Stepper
          display={`${fontSize}px`}
          valueMinWidth={48}
          decrementLabel={t("common.decrement")}
          incrementLabel={t("common.increment")}
          onDecrement={() => setFontSize(Math.max(10, fontSize - 1))}
          onIncrement={() => setFontSize(Math.min(22, fontSize + 1))}
        />
      </div>
      <div style={{ marginBottom: 24 }}>
        <div style={SECTION_LABEL}>{t("settings.appearance.font_family")}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <input
            value={fontDraft}
            onChange={(e) => setFontDraft(e.target.value)}
            onBlur={() => setFontFamily(fontDraft)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                setFontFamily(fontDraft);
                e.currentTarget.blur();
              }
            }}
            spellCheck={false}
            style={{ flex: "1 1 260px", minWidth: 0, height: 30, border: "1px solid var(--c-border-2)", borderRadius: "var(--r-btn)", background: "var(--c-bg-white)", color: "var(--c-text-primary)", padding: "0 10px", fontFamily: "var(--font-mono)", fontSize: "var(--fs-body)", outline: "none" }}
          />
          <button
            type="button"
            aria-pressed={nerdFontFallback}
            onClick={() => setNerdFontFallback(!nerdFontFallback)}
            style={{
              height: 30, padding: "0 10px", borderRadius: "var(--r-btn)", border: "1px solid var(--c-border-2)", cursor: "pointer",
              background: nerdFontFallback ? "var(--c-accent)" : "var(--c-bg-white)",
              color: nerdFontFallback ? "var(--c-btn-primary-text)" : "var(--c-text-3)",
              fontSize: "var(--fs-secondary)", fontWeight: 600, flexShrink: 0,
            }}
          >
            {t("settings.appearance.nerd_font")}
          </button>
          <button
            type="button"
            aria-pressed={fontLigatures}
            onClick={() => setFontLigatures(!fontLigatures)}
            style={{
              height: 30, padding: "0 10px", borderRadius: "var(--r-btn)", border: "1px solid var(--c-border-2)", cursor: "pointer",
              background: fontLigatures ? "var(--c-accent)" : "var(--c-bg-white)",
              color: fontLigatures ? "var(--c-btn-primary-text)" : "var(--c-text-3)",
              fontSize: "var(--fs-secondary)", fontWeight: 600, flexShrink: 0,
            }}
          >
            {t("settings.appearance.ligatures")}
          </button>
        </div>
        <div style={{ ...SECTION_HINT, marginTop: 6 }}>
          {t("settings.appearance.font_family.suggest")}
        </div>
      </div>
      <div style={{ marginBottom: 24 }}>
        <div style={SECTION_LABEL}>{t("settings.appearance.scrollback")}</div>
        <Stepper
          display={`${scrollback}`}
          valueMinWidth={64}
          decrementLabel={t("common.decrement")}
          incrementLabel={t("common.increment")}
          onDecrement={() => setScrollback(Math.max(1000, scrollback - 1000))}
          onIncrement={() => setScrollback(Math.min(20000, scrollback + 1000))}
        />
      </div>
      <ToggleRow label={t("settings.appearance.bell_notification")} hint={t("settings.appearance.bell_notification.hint")} checked={bellNotification} onChange={setBellNotification} />
      <ToggleRow label={t("settings.appearance.clipboard_write")} hint={t("settings.appearance.clipboard_write.hint")} checked={terminalClipboardWrite} onChange={() => setTerminalClipboardWrite(!terminalClipboardWrite)} />
      <ToggleRow label={t("settings.appearance.inline_images")} hint={t("settings.appearance.inline_images.hint")} checked={terminalInlineImages} onChange={setTerminalInlineImages} />
      <ToggleRow label={t("settings.appearance.pure_files_button")} hint={t("settings.appearance.pure_files_button.hint")} checked={showPureModeFilesButton} onChange={setShowPureModeFilesButton} />
      <div style={{ marginTop: 24 }}>
        <div style={SECTION_LABEL}>{t("settings.appearance.external_editor")}</div>
        <Segmented
          ariaLabel={t("settings.appearance.external_editor")}
          options={EXTERNAL_EDITORS.map((ed: ExternalEditor) => ({ id: ed, label: EDITOR_LABELS[ed] }))}
          value={externalEditor}
          onChange={setExternalEditor}
        />
      </div>
    </div>
  );
}
