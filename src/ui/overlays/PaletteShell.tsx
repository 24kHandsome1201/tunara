import type React from "react";
import { useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import { useT } from "@/modules/i18n";
import { formatShortcut } from "../formatShortcut";
import { useFocusTrap } from "./useFocusTrap";

interface PaletteShellProps {
  ariaLabel: string;
  onClose: () => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
  wide?: boolean;
  maxHeight?: CSSProperties["maxHeight"];
  children: ReactNode;
}

/** Shared top-anchored palette surface (backdrop + dialog + focus trap). */
export function PaletteShell({
  ariaLabel,
  onClose,
  onKeyDown,
  wide = false,
  maxHeight = "60vh",
  children,
}: PaletteShellProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef);
  return (
    <>
      <div
        aria-hidden="true"
        onClick={onClose}
        className="overlay-backdrop"
        style={{
          position: "fixed",
          inset: 0,
          zIndex: "var(--z-palette)",
          background: "var(--backdrop-color)",
        }}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        onKeyDown={onKeyDown}
        className="overlay-palette"
        style={{
          position: "fixed",
          top: "var(--palette-top)",
          left: "50%",
          transform: "translateX(-50%)",
          width: wide ? "var(--w-palette-wide)" : "var(--w-palette)",
          maxWidth: "90vw",
          maxHeight,
          background: "var(--c-bg-white)",
          border: "1px solid var(--c-control-border)",
          borderRadius: "var(--r-overlay)",
          boxShadow: "var(--shadow-overlay)",
          zIndex: "var(--z-palette)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {children}
      </div>
    </>
  );
}

interface PaletteInputProps {
  inputRef: RefObject<HTMLInputElement | null>;
  composingRef: RefObject<boolean>;
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  ariaControls: string;
  ariaActiveDescendant?: string;
  ariaInvalid?: boolean;
  placeholder: string;
  spellCheck?: boolean;
}

/** Borderless combobox input shared by palette-style overlays. */
export function PaletteInput({
  inputRef,
  composingRef,
  value,
  onChange,
  ariaLabel,
  ariaControls,
  ariaActiveDescendant,
  ariaInvalid,
  placeholder,
  spellCheck,
}: PaletteInputProps) {
  return (
    <input
      className="ui-control"
      ref={inputRef}
      type="text"
      role="combobox"
      aria-expanded="true"
      aria-controls={ariaControls}
      aria-activedescendant={ariaActiveDescendant}
      aria-autocomplete="list"
      aria-invalid={ariaInvalid || undefined}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onCompositionStart={() => { composingRef.current = true; }}
      onCompositionEnd={(event) => {
        composingRef.current = false;
        // Chromium syncs the final value into input.value only after
        // compositionend; sync once so filtering sees the composed string.
        onChange((event.target as HTMLInputElement).value);
      }}
      aria-label={ariaLabel}
      placeholder={placeholder}
      spellCheck={spellCheck}
      style={{
        flex: 1,
        border: "none",
        background: "transparent",
        fontSize: "var(--fs-body)",
        color: "var(--c-text-primary)",
        fontFamily: "var(--font-ui)",
      }}
    />
  );
}

export function PaletteHeader({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: "12px 16px",
        borderBottom: "1px solid var(--c-border-1)",
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      {children}
    </div>
  );
}

interface PaletteListProps {
  id: string;
  ariaLabel: string;
  listRef: RefObject<HTMLDivElement | null>;
  hasItems?: boolean;
  className?: string;
  children: ReactNode;
}

export function PaletteList({
  id,
  ariaLabel,
  listRef,
  hasItems = true,
  className = "no-scrollbar scroll-fade-y",
  children,
}: PaletteListProps) {
  return (
    <div
      ref={listRef}
      role="listbox"
      id={id}
      aria-label={ariaLabel}
      style={{ flex: 1, overflowY: "auto", padding: hasItems ? "6px 0" : 0 }}
      className={className}
    >
      {children}
    </div>
  );
}

/** Shared empty-state row for palette results. */
export function PaletteEmpty({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: "20px 16px",
        textAlign: "center",
        fontSize: "var(--fs-meta)",
        color: "var(--c-text-5)",
      }}
    >
      {children}
    </div>
  );
}

interface PaletteFooterHint {
  /** Canonical shortcut definition, e.g. "Escape" (rendered via formatShortcut). */
  keys: string;
  label: string;
}

/** Footer row of keyboard hints (`⎋` / `↩` on macOS, `Esc` / `Enter` elsewhere). */
export function PaletteFooter({ hints }: { hints: PaletteFooterHint[] }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "8px 16px",
        borderTop: "1px solid var(--c-border-1)",
        fontSize: "var(--fs-meta)",
        color: "var(--c-text-5)",
      }}
    >
      {hints.map((hint) => (
        <span key={hint.keys + hint.label} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <kbd className="ui-kbd">{formatShortcut(hint.keys)}</kbd>
          {hint.label}
        </span>
      ))}
    </div>
  );
}

/** The shared ↑↓ / ↩ / ⎋ hint set used by palette-style overlays. */
export function usePaletteFooterHints(): PaletteFooterHint[] {
  const t = useT();
  return [
    { keys: "ArrowUp+ArrowDown", label: t("palette.hint.navigate") },
    { keys: "Enter", label: t("palette.hint.select") },
    { keys: "Escape", label: t("palette.hint.close") },
  ];
}
