import type { ButtonHTMLAttributes, ComponentPropsWithRef, CSSProperties, ReactNode } from "react";
import { useT } from "@/modules/i18n";
import { PanelEmptyGlyph, PanelErrorGlyph } from "@/ui/icons";
import { Tooltip } from "./Tooltip";
import { useDestructiveConfirmCountdown } from "./lib/destructive-confirm";

export {
  CloseIcon,
  DownloadIcon,
  RefreshIcon,
  SearchIcon,
  UploadFolderIcon,
  UploadIcon,
} from "@/ui/icons";

export type PanelAsyncState =
  | { kind: "loading"; label: string }
  | { kind: "empty"; label: string; detail?: string }
  | { kind: "error"; label: string; detail?: string; retryLabel?: string; onRetry?: () => void; remediation?: ReactNode };

/** Small status dot; loading states pass `pulse` (loadPulse, motion-aware via .loading-dot). */
export function StatusDot({
  size = "sm",
  tone = "currentColor",
  pulse = false,
  style,
}: {
  size?: "sm" | "md";
  tone?: CSSProperties["backgroundColor"];
  pulse?: boolean;
  style?: CSSProperties;
}) {
  const dim = size === "md" ? "var(--dot-md)" : "var(--dot-sm)";
  return (
    <span
      aria-hidden="true"
      className={pulse ? "loading-dot" : undefined}
      style={{
        display: "inline-block",
        width: dim,
        height: dim,
        borderRadius: "50%",
        background: tone,
        flexShrink: 0,
        ...style,
      }}
    />
  );
}

/**
 * Shared pending state for "click again to confirm" destructive actions:
 * danger-colored label plus the remaining seconds and a progress bar that
 * drain over the confirm window. The label is announced through aria-live;
 * the ticking seconds and the bar stay aria-hidden so they don't spam.
 */
export function DestructiveConfirmNotice({
  confirmedAt,
  label,
}: {
  confirmedAt: number;
  label: string;
}) {
  const countdown = useDestructiveConfirmCountdown(confirmedAt);
  return (
    <div aria-live="polite" style={{ marginTop: 6 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          fontSize: "var(--fs-meta)",
          color: "var(--c-error)",
          lineHeight: 1.3,
        }}
      >
        <span style={{ minWidth: 0 }}>{label}</span>
        {countdown && (
          <span
            aria-hidden="true"
            style={{
              flexShrink: 0,
              fontFamily: "var(--font-mono)",
              fontWeight: 600,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {countdown.remainingSeconds}s
          </span>
        )}
      </div>
      {countdown && (
        <div
          aria-hidden="true"
          style={{
            marginTop: 4,
            height: 2,
            borderRadius: "var(--r-pill)",
            overflow: "hidden",
            background: "color-mix(in srgb, var(--c-error) 12%, transparent)",
          }}
        >
          <span
            style={{
              display: "block",
              width: `${countdown.progress * 100}%`,
              height: "100%",
              borderRadius: "var(--r-pill)",
              background: "var(--c-error)",
              transition: "width var(--dur-fast) var(--ease-out)",
            }}
          />
        </div>
      )}
    </div>
  );
}

export function PanelToolbar({
  title,
  titleId,
  children,
}: {
  title: ReactNode;
  titleId?: string;
  children?: ReactNode;
}) {
  return (
    <header className="panel-toolbar">
      <h2 id={titleId} className="panel-toolbar-title">
        {title}
      </h2>
      {children && <div className="panel-toolbar-actions">{children}</div>}
    </header>
  );
}

export function PanelActionButton({
  className,
  style,
  disabled,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      type={type}
      disabled={disabled}
      className={["ui-button", className].filter(Boolean).join(" ")}
      style={{
        minHeight: 26,
        padding: "3px 8px",
        fontFamily: "var(--font-ui)",
        fontSize: "var(--fs-meta)",
        lineHeight: 1.25,
        ...style,
      }}
    />
  );
}

export function PanelIconButton({
  className,
  type = "button",
  title,
  ...props
}: ComponentPropsWithRef<"button">) {
  const button = (
    <button
      {...props}
      type={type}
      aria-label={props["aria-label"] ?? (typeof title === "string" ? title : undefined)}
      className={["panel-icon-button", "hover-bg", className].filter(Boolean).join(" ")}
    />
  );
  return typeof title === "string" && title ? <Tooltip label={title}>{button}</Tooltip> : button;
}

export function PanelState({ state, icon, compact = false, action }: { state: PanelAsyncState; icon?: ReactNode; compact?: boolean; action?: ReactNode }) {
  const t = useT();
  const defaultIcon = state.kind === "error" ? <PanelErrorGlyph /> : <PanelEmptyGlyph />;
  return (
    <div
      role={state.kind === "error" ? "alert" : "status"}
      aria-live={state.kind === "loading" || state.kind === "empty" ? "polite" : undefined}
      aria-busy={state.kind === "loading" ? true : undefined}
      data-density={compact ? "compact" : "regular"}
      data-state={state.kind}
      className="panel-state"
    >
      <div className="panel-state-icon">
        {state.kind === "loading"
          ? <StatusDot pulse />
          : icon ?? defaultIcon}
      </div>
      <div className="panel-state-copy">
        <strong>{state.label}</strong>
        {state.kind !== "loading" && state.detail && <span className="panel-state-detail">{state.detail}</span>}
        {state.kind === "error" && state.remediation && <span className="panel-state-remediation">{state.remediation}</span>}
        {state.kind === "error" && state.onRetry && <PanelActionButton onClick={state.onRetry}>{state.retryLabel ?? t("common.retry")}</PanelActionButton>}
        {action}
      </div>
    </div>
  );
}

export function PanelEmptyState({ icon, label, sublabel, compact = true, action }: { icon?: ReactNode; label: string; sublabel?: string; compact?: boolean; action?: ReactNode }) {
  return <PanelState state={{ kind: "empty", label, detail: sublabel }} icon={icon} compact={compact} action={action} />;
}

export function PanelLoadingState({ label }: { label: string }) {
  return <PanelState state={{ kind: "loading", label }} />;
}
