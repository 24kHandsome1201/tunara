import { useEffect, useState } from "react";
import { useUIStore } from "@/state/ui";
import { isDarkTheme } from "@/styles/terminalTheme";
import { useT, LANGUAGES, type Language } from "@/modules/i18n";
import {
  ColorSchemeCard,
  handleRadioGroupKeyDown,
  SECTION_LABEL,
  Segmented,
  type ColorSchemeId,
} from "./controls";
import { AccessibilitySettings } from "./AccessibilitySettings";
import { TerminalSettings } from "./TerminalSettings";

/** Combined General tab: color scheme, language, terminal, accessibility. */
export function AppearanceSettings() {
  const t = useT();
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);
  const language = useUIStore((s) => s.language);
  const setLanguage = useUIStore((s) => s.setLanguage);

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
      <TerminalSettings />
      <AccessibilitySettings />
    </div>
  );
}
