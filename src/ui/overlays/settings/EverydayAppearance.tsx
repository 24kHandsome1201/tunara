import { useEffect, useRef, useState } from "react";
import { useT } from "@/modules/i18n";
import { buildTerminalFontFamily } from "@/modules/terminal/lib/terminal-font";
import { useUIStore } from "@/state/ui";
import { getTerminalTheme, isDarkTheme } from "@/styles/terminalTheme";
import { Segmented, Stepper } from "./controls";

const presets = [
  { id: "classic", theme: "light", fontSize: 14 },
  { id: "night", theme: "dark", fontSize: 14 },
  { id: "large_text", theme: "light", fontSize: 18 },
] as const;

const fonts = ["JetBrains Mono", "Menlo", "SF Mono", "Monaco", "Courier New"];

export function EverydayAppearance() {
  const t = useT();
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);
  const fontFamily = useUIStore((s) => s.fontFamily);
  const setFontFamily = useUIStore((s) => s.setFontFamily);
  const fontSize = useUIStore((s) => s.fontSize);
  const setFontSize = useUIStore((s) => s.setFontSize);
  const nerdFontFallback = useUIStore((s) => s.nerdFontFallback);
  const [fontDraft, setFontDraft] = useState(fontFamily);
  const composingFont = useRef(false);
  useEffect(() => { setFontDraft(fontFamily); }, [fontFamily]);

  const [systemIsDark, setSystemIsDark] = useState(() => isDarkTheme("system"));
  useEffect(() => {
    if (theme !== "system") return;
    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;
    const onChange = (event: MediaQueryListEvent) => setSystemIsDark(event.matches);
    setSystemIsDark(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  const palette = getTerminalTheme(theme === "system" ? (systemIsDark ? "dark" : "light") : theme);

  function commitFont() {
    setFontFamily(fontDraft);
    setFontDraft(useUIStore.getState().fontFamily);
  }

  return (
    <section aria-labelledby="settings-section-appearance">
      <h2 id="settings-section-appearance" className="settings-layout-heading">{t("settings.section.appearance")}</h2>
      <p className="settings-layout-hint">{t("settings.presets.hint")}</p>
      <div className="settings-presets" role="group" aria-label={t("settings.presets.title")}>
        {presets.map(({ id, theme: presetTheme, fontSize: presetSize }) => (
          <button
            type="button"
            key={id}
            className="settings-preset"
            aria-pressed={theme === presetTheme && fontSize === presetSize}
            onClick={() => useUIStore.setState({ theme: presetTheme, fontSize: presetSize })}
          >
            <span className="settings-preset-icon" data-preset={id} aria-hidden="true">
              {id === "large_text" ? "Aa" : <svg width="22" height="14" viewBox="0 0 22 14" fill="none" stroke="currentColor" strokeLinecap="round"><path d="M3 5h16M3 9h10" /></svg>}
            </span>
            <span>
              <strong>{t(`settings.presets.${id}`)}</strong>
              <span className="settings-layout-hint">{t(`settings.appearance.theme.${presetTheme}`)} · {presetSize} px</span>
            </span>
            <span className="settings-preset-check" aria-hidden="true">✓</span>
          </button>
        ))}
      </div>
      <div className="settings-appearance-grid">
        <div className="settings-appearance-controls">
          <div>
            <h3 className="settings-layout-label">{t("settings.everyday.theme")}</h3>
            <p className="settings-layout-hint">{t("settings.everyday.theme_hint")}</p>
            <Segmented
              ariaLabel={t("settings.everyday.theme")}
              options={[
                { id: "system", label: t("settings.appearance.theme.system") },
                { id: "light", label: t("settings.appearance.theme.light") },
                { id: "dark", label: t("settings.appearance.theme.dark") },
              ]}
              value={theme}
              onChange={setTheme}
            />
          </div>
          <div>
            <label className="settings-layout-label" htmlFor="settings-font-family">{t("settings.everyday.font")}</label>
            <p className="settings-layout-hint">{t("settings.everyday.font_hint")}</p>
            <div className="settings-font-controls">
              <input
                id="settings-font-family"
                className="settings-font-family"
                list="settings-font-choices"
                value={fontDraft}
                onChange={(e) => setFontDraft(e.target.value)}
                onCompositionStart={() => { composingFont.current = true; }}
                onCompositionEnd={(e) => { composingFont.current = false; setFontDraft(e.currentTarget.value); }}
                onBlur={() => { if (!composingFont.current) commitFont(); }}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
                spellCheck={false}
              />
              <datalist id="settings-font-choices">
                {fonts.map((font) => <option key={font} value={font} />)}
              </datalist>
              <Stepper display={`${fontSize} px`} valueMinWidth={40} decrementLabel={`${t("common.decrement")} · ${t("settings.appearance.font_size")}`} incrementLabel={`${t("common.increment")} · ${t("settings.appearance.font_size")}`} onDecrement={() => setFontSize(fontSize - 1)} onIncrement={() => setFontSize(fontSize + 1)} />
            </div>
          </div>
        </div>
        <figure className="settings-preview" aria-labelledby="settings-preview-title">
          <figcaption>
            <span id="settings-preview-title"><span aria-hidden="true">›_ </span>{t("settings.everyday.preview")}</span>
            <span className="settings-preview-live">{t("settings.everyday.live")}</span>
          </figcaption>
          <div
            className="settings-preview-terminal"
            style={{
              backgroundColor: palette.background,
              color: palette.foreground,
              fontFamily: buildTerminalFontFamily(composingFont.current ? fontFamily : fontDraft, nerdFontFallback),
              fontSize,
            }}
          >
            <div><span style={{ color: palette.yellow }}>~</span> $ ls</div>
            <div className="settings-preview-files"><span style={{ color: palette.blue }}>projects</span><span>notes.md</span><span>README.md</span></div>
            <div><span style={{ color: palette.yellow }}>~</span> $ <span aria-hidden="true" className="settings-preview-cursor" style={{ background: palette.cursor }} /></div>
          </div>
        </figure>
      </div>
    </section>
  );
}
