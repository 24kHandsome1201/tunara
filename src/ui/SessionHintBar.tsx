import type { ReactNode } from "react";
import { CloseIcon } from "./shared";
import { AccentActionButton } from "./lib/ui-primitives";

interface SessionHintBarProps {
  children: ReactNode;
  actionLabel: string;
  onAction: () => void;
  dismissLabel: string;
  onDismiss: () => void;
}

/** Compact one-shot prompt above a terminal pane. SSH / Preview / Changes share this chrome. */
export function SessionHintBar({
  children,
  actionLabel,
  onAction,
  dismissLabel,
  onDismiss,
}: SessionHintBarProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        minHeight: "var(--h-inline-bar)",
        margin: "4px 8px 0",
        flexShrink: 0,
        background: "var(--c-bg-1)",
        border: "1px solid var(--c-border-1)",
        borderRadius: "var(--r-btn)",
        display: "flex",
        alignItems: "center",
        padding: "4px 6px 4px 10px",
        gap: 8,
        flexWrap: "wrap",
        animation: "statusBarSlideIn var(--duration-normal) var(--ease-out-expo)",
      }}
    >
      <span
        style={{
          fontSize: "var(--fs-meta)",
          color: "var(--c-text-2)",
          lineHeight: "16px",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "normal",
          minWidth: 0,
          flex: "1 1 120px",
        }}
      >
        {children}
      </span>
      <AccentActionButton
        onClick={() => onAction()}
        title={actionLabel}
        ariaLabel={actionLabel}
        style={{ marginLeft: "auto", flexShrink: 0 }}
      >
        {actionLabel}
      </AccentActionButton>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={dismissLabel}
        title={dismissLabel}
        className="hover-bg"
        style={{
          width: 22,
          height: 22,
          flexShrink: 0,
          border: "none",
          background: "transparent",
          cursor: "pointer",
          color: "var(--c-text-4)",
          borderRadius: "var(--r-btn)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <CloseIcon />
      </button>
    </div>
  );
}
