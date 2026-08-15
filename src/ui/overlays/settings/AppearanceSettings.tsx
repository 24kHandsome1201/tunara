import { useEffect, useState } from "react";
import { useUIStore, type CursorStyle, type ExternalEditor, EXTERNAL_EDITORS, EDITOR_LABELS } from "@/state/ui";
import { isDarkTheme } from "@/styles/terminalTheme";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useT, LANGUAGES, type Language } from "@/modules/i18n";
import {
  ACCENT_COLORS,
  AccentRing,
  ColorSchemeCard,
  IS_MAC,
  SECTION_HINT,
  SECTION_LABEL,
  SECTION_LABEL_INLINE,
  Segmented,
  Stepper,
  Toggle,
  ToggleRow,
  TOGGLE_ROW,
  type ColorSchemeId,
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

/** Appearance tab: theme, accent, cursor, fonts, terminal presentation. */
export function AppearanceSettings() {
  const t = useT();
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);
  const accent = useUIStore((s) => s.accent);
  const setAccent = useUIStore((s) => s.setAccent);
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
  const terminalScreenReaderMode = useUIStore((s) => s.terminalScreenReaderMode);
  const setTerminalScreenReaderMode = useUIStore((s) => s.setTerminalScreenReaderMode);
  const showPureModeFilesButton = useUIStore((s) => s.showPureModeFilesButton);
  const setShowPureModeFilesButton = useUIStore((s) => s.setShowPureModeFilesButton);
  const terminalTheme = useUIStore((s) => s.terminalTheme);
  const setTerminalTheme = useUIStore((s) => s.setTerminalTheme);
  const externalEditor = useUIStore((s) => s.externalEditor);
  const setExternalEditor = useUIStore((s) => s.setExternalEditor);
  const language = useUIStore((s) => s.language);
  const setLanguage = useUIStore((s) => s.setLanguage);

  const [fontDraft, setFontDraft] = useState(fontFamily);
  useEffect(() => { setFontDraft(fontFamily); }, [fontFamily]);

  // Track the OS scheme so "System" and named-scheme previews stay accurate.
  const [systemIsDark, setSystemIsDark] = useState(() => isDarkTheme("system"));
  useEffect(() => {
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    const onChange = (event: MediaQueryListEvent) => setSystemIsDark(event.matches);
    setSystemIsDark(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  const colorSchemeOptions: { id: ColorSchemeId; label: string }[] = [
    { id: "system", label: t("settings.appearance.theme.system") },
    { id: "light", label: t("settings.appearance.theme.light") },
    { id: "dark", label: t("settings.appearance.theme.dark") },
    { id: "github-light", label: t("settings.appearance.theme.github_light") },
    { id: "rose-pine-dawn", label: t("settings.appearance.theme.rose_pine_dawn") },
    { id: "catppuccin", label: t("settings.appearance.theme.catppuccin") },
    { id: "tokyo-night", label: t("settings.appearance.theme.tokyo_night") },
    { id: "one-dark", label: t("settings.appearance.theme.one_dark") },
    { id: "solarized", label: t("settings.appearance.theme.solarized") },
  ];
  const selectedColorScheme: ColorSchemeId = terminalTheme === "default" ? theme : terminalTheme;
  const selectColorScheme = (id: ColorSchemeId) => {
    if (id === "light" || id === "dark" || id === "system") {
      setTheme(id);
      setTerminalTheme("default");
      return;
    }
    setTerminalTheme(id);
  };

  const handleColorSchemeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-color-scheme]");
    const currentIndex = colorSchemeOptions.findIndex(({ id }) => id === target?.dataset.colorScheme);
    if (currentIndex < 0) return;

    let nextIndex: number | undefined;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") nextIndex = (currentIndex + 1) % colorSchemeOptions.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") nextIndex = (currentIndex - 1 + colorSchemeOptions.length) % colorSchemeOptions.length;
    else if (e.key === "Home") nextIndex = 0;
    else if (e.key === "End") nextIndex = colorSchemeOptions.length - 1;
    if (nextIndex === undefined) return;

    e.preventDefault();
    const nextId = colorSchemeOptions[nextIndex].id;
    selectColorScheme(nextId);
    e.currentTarget.querySelector<HTMLButtonElement>(`[data-color-scheme="${nextId}"]`)?.focus();
  };

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <div id="color-scheme-label" style={SECTION_LABEL}>{t("settings.appearance.terminal_theme")}</div>
        <div id="color-scheme-description" style={{ fontSize: "var(--fs-secondary)", lineHeight: 1.45, color: "var(--c-text-4)", marginBottom: 10, marginTop: -4 }}>
          {t("settings.appearance.terminal_theme.hint")}
        </div>
        <div
          role="radiogroup"
          aria-labelledby="color-scheme-label"
          aria-describedby="color-scheme-description"
          onKeyDown={handleColorSchemeKeyDown}
          style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(132px, 1fr))", gap: 8 }}
        >
          {colorSchemeOptions.map((entry) => (
            <ColorSchemeCard
              key={entry.id}
              id={entry.id}
              label={entry.label}
              selected={selectedColorScheme === entry.id}
              systemIsDark={systemIsDark}
              onClick={() => selectColorScheme(entry.id)}
            />
          ))}
        </div>
      </div>
      <div style={{ marginBottom: 24 }}>
        <div style={SECTION_LABEL}>{t("settings.appearance.accent")}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {ACCENT_COLORS.map((ac) => (
            <AccentRing key={ac.color} color={ac.color} label={t(ac.labelKey)} selected={accent === ac.color} onClick={() => setAccent(ac.color)} />
          ))}
          <span style={{ marginLeft: "auto", fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)" }}>
            {(() => { const match = ACCENT_COLORS.find((ac) => ac.color === accent); return match ? t(match.labelKey) : accent; })()}
          </span>
        </div>
      </div>
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
      <ToggleRow label={t("settings.appearance.screen_reader_mode")} hint={t("settings.appearance.screen_reader_mode.hint")} checked={terminalScreenReaderMode} onChange={setTerminalScreenReaderMode} />
      <ToggleRow label={t("settings.appearance.pure_files_button")} hint={t("settings.appearance.pure_files_button.hint")} checked={showPureModeFilesButton} onChange={setShowPureModeFilesButton} />
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
      <div style={{ marginTop: 24 }}>
        <div style={SECTION_LABEL}>{t("settings.appearance.external_editor")}</div>
        <Segmented
          ariaLabel={t("settings.appearance.external_editor")}
          options={EXTERNAL_EDITORS.map((ed: ExternalEditor) => ({ id: ed, label: EDITOR_LABELS[ed] }))}
          value={externalEditor}
          onChange={setExternalEditor}
        />
      </div>
      <div style={{ marginTop: 24 }}>
        <div style={SECTION_LABEL}>{t("settings.appearance.language")}</div>
        <Segmented
          ariaLabel={t("settings.appearance.language")}
          options={LANGUAGES.map((lang: Language) => ({
            id: lang,
            label: lang === "system" ? t("settings.appearance.language.system") : lang === "zh-CN" ? t("settings.appearance.language.zh_cn") : t("settings.appearance.language.en"),
          }))}
          value={language}
          onChange={setLanguage}
        />
      </div>
    </div>
  );
}
