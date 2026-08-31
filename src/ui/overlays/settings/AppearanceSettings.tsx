import { useEffect, useState } from "react";
import { useUIStore } from "@/state/ui";
import { isDarkTheme } from "@/styles/terminalTheme";
import { useT, LANGUAGES, type Language } from "@/modules/i18n";
import {
  ACCENT_COLORS,
  AccentRing,
  ColorSchemeCard,
  handleRadioGroupKeyDown,
  SECTION_LABEL,
  Segmented,
  type ColorSchemeId,
} from "./controls";

/** Appearance tab: theme, accent, and language. */
export function AppearanceSettings() {
  const t = useT();
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);
  const accent = useUIStore((s) => s.accent);
  const setAccent = useUIStore((s) => s.setAccent);
  const terminalTheme = useUIStore((s) => s.terminalTheme);
  const setTerminalTheme = useUIStore((s) => s.setTerminalTheme);
  const language = useUIStore((s) => s.language);
  const setLanguage = useUIStore((s) => s.setLanguage);

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
