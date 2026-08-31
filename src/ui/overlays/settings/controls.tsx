import type { ThemeType, TerminalThemeName } from "../../types";
import { getShellTint, getTerminalTheme } from "@/styles/terminalTheme";
import { platform } from "@tauri-apps/plugin-os";

/** Shared section / row styles for all settings tabs. */
export const SECTION_LABEL: React.CSSProperties = { fontSize: "var(--fs-body)", fontWeight: 600, color: "var(--c-text-3)", marginBottom: 10 };
export const SECTION_LABEL_INLINE: React.CSSProperties = { fontSize: "var(--fs-body)", fontWeight: 600, color: "var(--c-text-3)" };
export const SECTION_HINT: React.CSSProperties = { fontSize: "var(--fs-secondary)", color: "var(--c-text-4)", marginTop: 6 };
export const TOGGLE_ROW: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", height: 28, marginBottom: 10 };

const TOGGLE_BUTTON: React.CSSProperties = {
  width: 36, height: 20, borderRadius: 10, border: "none", padding: 2, cursor: "pointer",
  display: "flex", alignItems: "center", flexShrink: 0,
  transition: "background var(--duration-normal) var(--ease-smooth)",
};
const TOGGLE_KNOB: React.CSSProperties = {
  width: 16, height: 16, borderRadius: "50%", background: "var(--c-bg-white)",
  boxShadow: "var(--shadow-card)",
  transition: "transform var(--duration-normal) var(--ease-out-back)",
};

function detectIsMac(): boolean {
  try { return platform() === "macos"; } catch { return navigator.platform.toLowerCase().includes("mac"); }
}
export const IS_MAC = detectIsMac();

export function handleRadioGroupKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
  if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const radios = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)'));
  const currentIndex = radios.findIndex((radio) => radio === event.target || radio.contains(event.target as Node));
  if (currentIndex < 0 || radios.length === 0) return;

  event.preventDefault();
  const nextIndex = event.key === "Home"
    ? 0
    : event.key === "End"
      ? radios.length - 1
      : event.key === "ArrowRight" || event.key === "ArrowDown"
        ? (currentIndex + 1) % radios.length
        : (currentIndex - 1 + radios.length) % radios.length;
  radios[nextIndex].focus();
  radios[nextIndex].click();
}

/** On/off switch (role="switch") shared by all boolean settings. */
export function Toggle({ checked, onChange, ariaLabel }: { checked: boolean; onChange: (v: boolean) => void; ariaLabel: string }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      style={{ ...TOGGLE_BUTTON, background: checked ? "var(--c-accent)" : "var(--c-bg-3)" }}
    >
      <div style={{ ...TOGGLE_KNOB, transform: checked ? "translateX(16px)" : "translateX(0)" }} />
    </button>
  );
}

/** A titled row with a Toggle on the right and an optional hint below. */
export function ToggleRow({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={TOGGLE_ROW}>
        <span style={SECTION_LABEL_INLINE}>{label}</span>
        <Toggle checked={checked} onChange={onChange} ariaLabel={label} />
      </div>
      {hint && <div style={SECTION_HINT}>{hint}</div>}
    </div>
  );
}

/** Pill-style single-select segments (cursor style, external editor, language). */
export function Segmented<T extends string>({ options, value, onChange, ariaLabel }: { options: { id: T; label: string }[]; value: T; onChange: (v: T) => void; ariaLabel?: string }) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} onKeyDown={handleRadioGroupKeyDown} style={{ display: "flex", background: "var(--c-bg-3)", borderRadius: "var(--r-btn)", padding: 2, gap: 0 }}>
      {options.map((opt) => (
        <button
          key={opt.id} type="button" onClick={() => onChange(opt.id)}
          role="radio"
          aria-checked={opt.id === value}
          tabIndex={opt.id === value ? 0 : -1}
          data-active={opt.id === value ? "true" : "false"}
          className="settings-segment"
          style={{ flex: 1, padding: "5px 12px", border: "none", borderRadius: "var(--r-btn)", background: "transparent", color: opt.id === value ? "var(--c-text-primary)" : "var(--c-text-4)", fontSize: "var(--fs-body)", fontWeight: opt.id === value ? 600 : 400, cursor: "pointer", transition: "background var(--duration-normal) var(--ease-smooth), color var(--duration-normal) var(--ease-smooth), box-shadow var(--duration-normal) var(--ease-smooth)" }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/** −/value/+ numeric stepper (font size, scrollback). */
export function Stepper({ display, valueMinWidth, onDecrement, onIncrement, decrementLabel, incrementLabel }: { display: string; valueMinWidth: number; onDecrement: () => void; onIncrement: () => void; decrementLabel: string; incrementLabel: string }) {
  const btn: React.CSSProperties = { width: 32, height: 30, border: "none", background: "var(--c-bg-white)", color: "var(--c-text-2)", fontSize: "var(--fs-title)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" };
  return (
    <div style={{ display: "inline-flex", alignItems: "center", border: "1px solid var(--c-border-2)", borderRadius: "var(--r-btn)", overflow: "hidden" }}>
      <button type="button" onClick={onDecrement} aria-label={decrementLabel} className="hover-bg" style={{ ...btn, borderRight: "1px solid var(--c-border-2)" }}>−</button>
      <span style={{ minWidth: valueMinWidth, textAlign: "center", fontSize: "var(--fs-body)", fontFamily: "var(--font-mono)", color: "var(--c-text-primary)", padding: "0 4px" }}>{display}</span>
      <button type="button" onClick={onIncrement} aria-label={incrementLabel} className="hover-bg" style={{ ...btn, borderLeft: "1px solid var(--c-border-2)" }}>+</button>
    </div>
  );
}

/** Labeled range control (wallpaper blur / veil). */
export function RangeRow({ label, value, min, max, display, onChange, ariaLabel }: {
  label: string;
  value: number;
  min: number;
  max: number;
  display: string;
  onChange: (value: number) => void;
  ariaLabel: string;
}) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ ...TOGGLE_ROW, height: 28, marginBottom: 6 }}>
        <span style={SECTION_LABEL_INLINE}>{label}</span>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-secondary)", color: "var(--c-text-4)", minWidth: 40, textAlign: "right" }}>{display}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        aria-label={ariaLabel}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        onChange={(event) => onChange(Number(event.target.value))}
        style={{ width: "100%", accentColor: "var(--c-accent)" }}
      />
    </div>
  );
}

/** One entry in the unified interface + terminal color scheme picker: either a
 * base app theme (with the Tunara default terminal palette) or a named scheme
 * applied to both the interface and the terminal. */
export type ColorSchemeId = ThemeType | Exclude<TerminalThemeName, "default">;

export function terminalThemePreviewColors(
  id: ColorSchemeId,
  systemIsDark: boolean,
) {
  const usesDefaultPalette = id === "light" || id === "dark" || id === "system";
  const appTheme = usesDefaultPalette ? id : (systemIsDark ? "dark" : "light");
  const terminalTheme = usesDefaultPalette ? "default" : id;
  const dark = id === "dark" || (id === "system" && systemIsDark);
  const tint = getShellTint(terminalTheme);
  const terminalPalette = getTerminalTheme(appTheme, terminalTheme);

  // Fallbacks mirror the sRGB equivalents of the default tokens.css OKLCH
  // surfaces so the default-scheme preview matches the real window chrome.
  return {
    deepest: tint?.["--c-bg-white"] ?? (dark ? "#0f0b09" : "#fffdfb"),
    sidebar: tint?.["--c-bg-2"] ?? (dark ? "#1c1714" : "#f2ece9"),
    raised: tint?.["--c-bg-3"] ?? (dark ? "#25211e" : "#e9e2de"),
    terminal: terminalPalette.background,
    text: terminalPalette.foreground,
    secondaryText: tint?.["--c-text-4"] ?? (dark ? "#9f9a97" : "#5c5552"),
    border: tint?.["--c-border-2"] ?? (dark ? "#342f2c" : "#d4ceca"),
  };
}

export function ColorSchemeCard({ id, label, selected, systemIsDark, onClick }: { id: ColorSchemeId; label: string; selected: boolean; systemIsDark: boolean; onClick: () => void }) {
  const colors = terminalThemePreviewColors(id, systemIsDark);

  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      tabIndex={selected ? 0 : -1}
      data-color-scheme={id}
      onClick={onClick}
      style={{ width: "100%", minWidth: 0, border: selected ? "2px solid var(--c-accent)" : "1px solid var(--c-border-2)", borderRadius: "var(--r-card)", padding: 0, cursor: "pointer", background: "transparent", overflow: "hidden", textAlign: "left" }}
    >
      <div aria-hidden="true" data-color-scheme-preview="window" style={{ height: 62, background: colors.deepest, borderBottom: `1px solid ${colors.border}`, display: "flex", flexDirection: "column" }}>
        <div data-preview-region="titlebar" style={{ height: 10, flexShrink: 0, borderBottom: `1px solid ${colors.border}`, display: "flex", alignItems: "center", padding: "0 5px", gap: 2 }}>
          <div style={{ width: 12, height: 2, borderRadius: 1, background: colors.secondaryText, opacity: 0.65 }} />
          <div style={{ width: 6, height: 2, borderRadius: 1, background: colors.secondaryText, opacity: 0.35 }} />
        </div>
        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          <div data-preview-region="sidebar" style={{ width: 28, flexShrink: 0, background: colors.sidebar, borderRight: `1px solid ${colors.border}`, padding: "6px 4px", display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ width: "72%", height: 2, borderRadius: 1, background: colors.text, opacity: 0.72 }} />
            <div style={{ width: "100%", height: 5, borderRadius: 2, background: colors.raised }} />
            <div style={{ width: "85%", height: 2, borderRadius: 1, background: colors.secondaryText, opacity: 0.7 }} />
          </div>
          <div data-preview-region="terminal" style={{ flex: 1, minWidth: 0, background: colors.terminal, padding: "7px 6px", display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ width: "48%", height: 2, borderRadius: 1, background: colors.text, opacity: 0.9 }} />
            <div style={{ width: "78%", height: 2, borderRadius: 1, background: colors.text, opacity: 0.55 }} />
            <div style={{ width: "62%", height: 2, borderRadius: 1, background: colors.secondaryText, opacity: 0.7 }} />
          </div>
          <div data-preview-region="panel" style={{ width: 20, flexShrink: 0, background: colors.sidebar, borderLeft: `1px solid ${colors.border}`, padding: "6px 3px", display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ width: "100%", height: 4, borderRadius: 1, background: colors.raised }} />
            <div style={{ width: "72%", height: 2, borderRadius: 1, background: colors.secondaryText, opacity: 0.65 }} />
          </div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 10px" }}>
        <span aria-hidden="true" style={{ minWidth: 0, fontSize: "var(--fs-secondary)", lineHeight: 1.25, color: "var(--c-text-primary)", fontWeight: selected ? 600 : 400 }}>{label}</span>
        <div aria-hidden="true" style={{ width: 14, height: 14, marginLeft: 6, borderRadius: "50%", border: selected ? "5px solid var(--c-accent)" : "1.5px solid var(--c-radio-ring)", flexShrink: 0 }} />
      </div>
    </button>
  );
}

export function AccentRing({ color, label, selected, onClick }: { color: string; label: string; selected: boolean; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} title={label} aria-label={label} aria-pressed={selected} style={{ width: 26, height: 26, borderRadius: "50%", border: selected ? `2px solid ${color}` : "2px solid transparent", padding: 3, background: "transparent", cursor: "pointer", flexShrink: 0, boxShadow: "none", transition: "border-color var(--duration-fast) var(--ease-smooth)" }}>
      <div aria-hidden="true" style={{ width: "100%", height: "100%", borderRadius: "50%", background: color }} />
    </button>
  );
}

export const ACCENT_COLORS = [
  { color: "#c2683c", labelKey: "settings.appearance.accent.terracotta" },
  { color: "#2f9e7a", labelKey: "settings.appearance.accent.sage" },
  { color: "#4f6ef0", labelKey: "settings.appearance.accent.indigo" },
  { color: "#e0556b", labelKey: "settings.appearance.accent.rose" },
  { color: "#c4a060", labelKey: "settings.appearance.accent.sand" },
  { color: "#0f7a6a", labelKey: "settings.appearance.accent.teal" },
  { color: "#8534F3", labelKey: "settings.appearance.accent.violet" },
  { color: "#a4660a", labelKey: "settings.appearance.accent.amber" },
];
