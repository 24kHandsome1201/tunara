import { platform } from "@tauri-apps/plugin-os";

/** Shared section / row styles for the settings page. */
export const SECTION_LABEL: React.CSSProperties = { fontSize: "var(--fs-body)", fontWeight: 600, color: "var(--c-text-3)", marginBottom: 10 };
export const SECTION_LABEL_INLINE: React.CSSProperties = { fontSize: "var(--fs-body)", fontWeight: 600, color: "var(--c-text-3)" };
export const SECTION_HINT: React.CSSProperties = { fontSize: "var(--fs-secondary)", color: "var(--c-text-4)", marginTop: 6 };
export const TOGGLE_ROW: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", height: 28, marginBottom: 10 };

// The button is the 24px hit target; the visible 36×20 track sits inside it.
const TOGGLE_BUTTON: React.CSSProperties = {
  width: 36, height: 24, borderRadius: 12, border: "none", padding: 0, cursor: "pointer",
  display: "flex", alignItems: "center", flexShrink: 0, background: "transparent",
};
const TOGGLE_TRACK: React.CSSProperties = {
  width: 36, height: 20, borderRadius: 10, padding: 2,
  display: "flex", alignItems: "center",
  transition: "background var(--dur-base) var(--ease-out)",
};
const TOGGLE_KNOB: React.CSSProperties = {
  width: 16, height: 16, borderRadius: "50%", background: "var(--c-bg-white)",
  boxShadow: "var(--shadow-card)",
  transition: "transform var(--dur-base) var(--ease-out)",
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
      style={TOGGLE_BUTTON}
    >
      <span aria-hidden="true" style={{ ...TOGGLE_TRACK, background: checked ? "var(--c-accent)" : "var(--c-bg-3)" }}>
        <span style={{ ...TOGGLE_KNOB, transform: checked ? "translateX(16px)" : "translateX(0)" }} />
      </span>
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
          style={{ flex: 1, padding: "5px 12px", border: "none", borderRadius: "var(--r-btn)", background: "transparent", color: opt.id === value ? "var(--c-text-primary)" : "var(--c-text-4)", fontSize: "var(--fs-body)", fontWeight: opt.id === value ? 600 : 400, cursor: "pointer", transition: "background var(--dur-base) var(--ease-out), color var(--dur-base) var(--ease-out), box-shadow var(--dur-base) var(--ease-out)" }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/** −/value/+ numeric stepper (font size). */
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
