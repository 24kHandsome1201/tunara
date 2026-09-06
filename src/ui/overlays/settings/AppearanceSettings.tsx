import { useEffect, useRef, useState } from "react";
import { useUIStore } from "@/state/ui";
import { isDarkTheme } from "@/styles/terminalTheme";
import { useT, LANGUAGES, type Language } from "@/modules/i18n";
import {
  ColorSchemeCard,
  handleRadioGroupKeyDown,
  SECTION_HINT,
  SECTION_LABEL,
  SECTION_LABEL_INLINE,
  Segmented,
  Stepper,
  Toggle,
  TOGGLE_ROW,
  type ColorSchemeId,
} from "./controls";

function CursorStylePicker({ value, onChange }: { value: "bar" | "block" | "underline"; onChange: (v: "bar" | "block" | "underline") => void }) {
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

/** Appearance: color scheme, language, font, ligatures / Nerd Font, cursor. */
export function AppearanceSettings() {
  const t = useT();
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);
  const language = useUIStore((s) => s.language);
  const setLanguage = useUIStore((s) => s.setLanguage);
  const cursorStyle = useUIStore((s) => s.cursorStyle);
  const setCursorStyle = useUIStore((s) => s.setCursorStyle);
  const cursorBlink = useUIStore((s) => s.cursorBlink);
  const setCursorBlink = useUIStore((s) => s.setCursorBlink);
  const fontFamily = useUIStore((s) => s.fontFamily);
  const setFontFamily = useUIStore((s) => s.setFontFamily);
  const fontSize = useUIStore((s) => s.fontSize);
  const setFontSize = useUIStore((s) => s.setFontSize);
  const fontLigatures = useUIStore((s) => s.fontLigatures);
  const setFontLigatures = useUIStore((s) => s.setFontLigatures);
  const nerdFontFallback = useUIStore((s) => s.nerdFontFallback);
  const setNerdFontFallback = useUIStore((s) => s.setNerdFontFallback);

  const [fontDraft, setFontDraft] = useState(fontFamily);
  const composingFont = useRef(false);
  useEffect(() => { setFontDraft(fontFamily); }, [fontFamily]);

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
  ];

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
          onKeyDown={handleRadioGroupKeyDown}
          style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(132px, 1fr))", gap: 8 }}
        >
          {colorSchemeOptions.map((entry) => (
            <ColorSchemeCard
              key={entry.id}
              id={entry.id}
              label={entry.label}
              selected={theme === entry.id}
              systemIsDark={systemIsDark}
              onClick={() => setTheme(entry.id)}
            />
          ))}
        </div>
      </div>
      <div style={{ marginBottom: 24 }}>
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
      <div style={{ marginBottom: 24 }}>
        <label htmlFor="settings-font-family" style={SECTION_LABEL}>{t("settings.appearance.font_family")}</label>
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          <input
            id="settings-font-family"
            value={fontDraft}
            onChange={(e) => setFontDraft(e.target.value)}
            onCompositionStart={() => { composingFont.current = true; }}
            onCompositionEnd={() => { composingFont.current = false; }}
            onBlur={() => { if (!composingFont.current) setFontFamily(fontDraft); }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Enter") {
                setFontFamily(fontDraft);
                e.currentTarget.blur();
              }
            }}
            spellCheck={false}
            style={{ flex: "1 1 260px", minWidth: 0, height: 30, border: "1px solid var(--c-border-2)", borderRadius: "var(--r-btn)", background: "var(--c-bg-white)", color: "var(--c-text-primary)", padding: "0 10px", fontFamily: "var(--font-mono)", fontSize: "var(--fs-body)", outline: "none" }}
          />
          <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
            <span style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-4)" }}>{t("settings.appearance.font_size")}</span>
            <Stepper display={`${fontSize}px`} valueMinWidth={48} decrementLabel={`${t("common.decrement")} · ${t("settings.appearance.font_size")}`} incrementLabel={`${t("common.increment")} · ${t("settings.appearance.font_size")}`} onDecrement={() => setFontSize(Math.max(10, fontSize - 1))} onIncrement={() => setFontSize(Math.min(22, fontSize + 1))} />
          </div>
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
      <div style={{ marginBottom: 8 }}>
        <div style={TOGGLE_ROW}>
          <span style={SECTION_LABEL_INLINE}>{t("settings.appearance.cursor_style")}</span>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <span style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-4)" }}>{t("settings.appearance.cursor_blink")}</span>
            <Toggle checked={cursorBlink} onChange={setCursorBlink} ariaLabel={t("settings.appearance.cursor_blink")} />
          </label>
        </div>
        <CursorStylePicker value={cursorStyle} onChange={setCursorStyle} />
      </div>
      <button
        type="button"
        onClick={async () => {
          const { confirm } = await import("@tauri-apps/plugin-dialog");
          if (await confirm(t("settings.appearance.reset_confirm"), { kind: "warning" })) useUIStore.getState().resetAppearance();
        }}
        className="hover-bg settings-action-button"
        style={{ marginTop: 18, padding: "6px 12px", borderRadius: "var(--r-btn)", border: "1px solid var(--c-border-2)", background: "transparent", color: "var(--c-text-4)", cursor: "pointer" }}
      >
        {t("settings.appearance.reset_defaults")}
      </button>
    </div>
  );
}
