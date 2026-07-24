import type React from "react";

/**
 * Shared UI primitives for Tunara's inline surfaces.
 *
 * These consolidate the repeated "22px accent-bordered action button" and
 * "30px inline bar container" patterns that were copy-pasted across
 * SshSuggestionBar, TerminalExitBanner, PtyErrorBanner, and GlobalAgentBar.
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

/** Refresh icon used by retry/restart/reconnect action buttons. */
export function RestartIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
    </svg>
  );
}

/** Play/triangle icon used by resume action buttons. */
export function ResumeIcon({ size = 9 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  );
}
