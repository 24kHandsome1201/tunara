import { useUIStore } from "@/state/ui";
import { useT, LANGUAGES, type Language } from "@/modules/i18n";
import {
  SECTION_HINT,
  SECTION_LABEL,
  SECTION_LABEL_INLINE,
  Segmented,
  IS_MAC,
  Toggle,
  TOGGLE_ROW,
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

export function AppearanceSettings() {
  const t = useT();
  const language = useUIStore((s) => s.language);
  const setLanguage = useUIStore((s) => s.setLanguage);
  const cursorStyle = useUIStore((s) => s.cursorStyle);
  const setCursorStyle = useUIStore((s) => s.setCursorStyle);
  const cursorBlink = useUIStore((s) => s.cursorBlink);
  const setCursorBlink = useUIStore((s) => s.setCursorBlink);
  const fontLigatures = useUIStore((s) => s.fontLigatures);
  const setFontLigatures = useUIStore((s) => s.setFontLigatures);
  const nerdFontFallback = useUIStore((s) => s.nerdFontFallback);
  const setNerdFontFallback = useUIStore((s) => s.setNerdFontFallback);
  const backgroundOpacity = useUIStore((s) => s.backgroundOpacity);
  const setBackgroundOpacity = useUIStore((s) => s.setBackgroundOpacity);
  const backgroundBlur = useUIStore((s) => s.backgroundBlur);
  const setBackgroundBlur = useUIStore((s) => s.setBackgroundBlur);

  return (
    <div>
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
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          <button
            type="button"
            aria-pressed={nerdFontFallback}
            onClick={() => setNerdFontFallback(!nerdFontFallback)}
            style={{
              height: 30, padding: "0 10px", borderRadius: "var(--r-btn)", border: "1px solid var(--c-border-2)", cursor: "pointer",
              background: nerdFontFallback ? "var(--c-accent)" : "var(--c-bg-white)",
              color: nerdFontFallback ? "var(--c-on-accent)" : "var(--c-text-3)",
              fontSize: "var(--fs-secondary)", fontWeight: 600, flexShrink: 0, whiteSpace: "nowrap",
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
              color: fontLigatures ? "var(--c-on-accent)" : "var(--c-text-3)",
              fontSize: "var(--fs-secondary)", fontWeight: 600, flexShrink: 0, whiteSpace: "nowrap",
            }}
          >
            {t("settings.appearance.ligatures")}
          </button>
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
      {IS_MAC && (
        <div style={{ marginTop: 24 }}>
          <div style={TOGGLE_ROW}>
            <label htmlFor="settings-background-opacity" style={SECTION_LABEL_INLINE}>{t("settings.appearance.background_opacity")}</label>
            <span style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-4)", fontVariantNumeric: "tabular-nums" }}>{Math.round(backgroundOpacity * 100)}%</span>
          </div>
          <input
            id="settings-background-opacity"
            type="range"
            min={30}
            max={100}
            step={5}
            value={Math.round(backgroundOpacity * 100)}
            onChange={(e) => setBackgroundOpacity(Number(e.target.value) / 100)}
            style={{ width: "100%", accentColor: "var(--c-accent)" }}
          />
          <div style={{ ...TOGGLE_ROW, marginTop: 10 }}>
            <span style={SECTION_LABEL_INLINE}>{t("settings.appearance.background_blur")}</span>
            <Toggle checked={backgroundBlur} onChange={setBackgroundBlur} ariaLabel={t("settings.appearance.background_blur")} />
          </div>
          <div style={SECTION_HINT}>{t("settings.appearance.background_opacity.hint")}</div>
        </div>
      )}
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
