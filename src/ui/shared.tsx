import type { ButtonHTMLAttributes, ComponentPropsWithRef, ReactNode } from "react";
import { useT } from "@/modules/i18n";
import { PanelEmptyGlyph, PanelErrorGlyph } from "@/ui/icons";

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

export function PanelState({ state, icon, compact = false }: { state: PanelAsyncState; icon?: ReactNode; compact?: boolean }) {
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
          ? <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: "50%", background: "currentColor" }} />
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

export function PanelEmptyState({ icon, label, sublabel, compact = true }: { icon?: ReactNode; label: string; sublabel?: string; compact?: boolean }) {
  return <PanelState state={{ kind: "empty", label, detail: sublabel }} icon={icon} compact={compact} />;
}

export function PanelLoadingState({ label }: { label: string }) {
  return <PanelState state={{ kind: "loading", label }} />;
}
