import type { ButtonHTMLAttributes, ComponentPropsWithRef, ReactNode } from "react";
import { useT } from "@/modules/i18n";

export function RefreshIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 0 1-15.5 6.2" />
      <path d="M3 12A9 9 0 0 1 18.5 5.8" />
      <polyline points="18 2 18.5 5.8 14.8 6.2" />
      <polyline points="6 22 5.5 18.2 9.2 17.8" />
    </svg>
  );
}

export function SearchIcon({ size = 13, color = "var(--c-text-5)" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  );
}

export function CloseIcon({
  size = 13,
  strokeWidth = 2.3,
  color = "currentColor",
}: {
  size?: number;
  strokeWidth?: number;
  color?: string;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

export type PanelAsyncState =
  | { kind: "loading"; label: string }
  | { kind: "empty"; label: string; detail?: string }
  | { kind: "error"; label: string; detail?: string; retryLabel?: string; onRetry?: () => void; remediation?: string };

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
  ...props
}: ComponentPropsWithRef<"button">) {
  return (
    <button
      {...props}
      type={type}
      className={["panel-icon-button", "hover-bg", className].filter(Boolean).join(" ")}
    />
  );
}

export function PanelState({ state, icon, compact = false }: { state: PanelAsyncState; icon?: React.ReactNode; compact?: boolean }) {
  const t = useT();
  const defaultIcon = (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {state.kind === "error" ? <><path d="M12 3 2.8 20h18.4Z" /><path d="M12 9v5" /><path d="M12 17h.01" /></> : <><circle cx="12" cy="12" r="9" /><path d="M8 12h8" /></>}
    </svg>
  );
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
          ? <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor", animation: "loadPulse 1.5s var(--ease-in-out) infinite" }} />
          : icon ?? defaultIcon}
      </div>
      <div className="panel-state-copy">
        <strong>{state.label}</strong>
        {state.kind !== "loading" && state.detail && <span className="panel-state-detail">{state.detail}</span>}
        {state.kind === "error" && state.remediation && <span className="panel-state-remediation">{state.remediation}</span>}
        {state.kind === "error" && state.onRetry && <PanelActionButton onClick={state.onRetry}>{state.retryLabel ?? t("common.retry")}</PanelActionButton>}
      </div>
    </div>
  );
}

export function PanelEmptyState({ icon, label, sublabel, compact = true }: { icon?: React.ReactNode; label: string; sublabel?: string; compact?: boolean }) {
  return <PanelState state={{ kind: "empty", label, detail: sublabel }} icon={icon} compact={compact} />;
}

export function PanelLoadingState({ label }: { label: string }) {
  return <PanelState state={{ kind: "loading", label }} />;
}
