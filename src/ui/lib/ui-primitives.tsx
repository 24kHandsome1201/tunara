import type React from "react";

/**
 * Shared UI primitives for Tunara's inline surfaces.
 *
 * These consolidate the repeated "22px accent-bordered action button" and
 * "30px inline bar container" patterns that were copy-pasted across
 * TerminalExitBanner and PtyErrorBanner.
 * Extracting them keeps spacing, radius, and color decisions in one place so
 * future token changes propagate automatically.
 */

/** Accent-bordered action button used inside inline bars and banners. */
export function AccentActionButton({
  children,
  onClick,
  title,
  ariaLabel,
  className = "hover-accent-bg",
  style,
}: {
  children: React.ReactNode;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  title?: string;
  ariaLabel?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      className={className}
      style={{
        height: "var(--h-btn-sm)",
        flexShrink: 0,
        borderRadius: "var(--r-btn)",
        border: "1px solid var(--c-accent-border)",
        background: "var(--c-accent-bg-soft)",
        color: "var(--c-accent)",
        fontSize: "var(--fs-meta)",
        fontWeight: 600,
        cursor: "pointer",
        padding: "0 10px",
        display: "flex",
        alignItems: "center",
        gap: 4,
        transition: "background var(--duration-fast) var(--ease-smooth), transform var(--duration-fast) var(--ease-out-expo)",
        ...style,
      }}
    >
      {children}
    </button>
  );
}

export { RestartIcon, ResumeIcon } from "@/ui/icons";
