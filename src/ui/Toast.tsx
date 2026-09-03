import { useEffect, useRef, useState } from "react";
import { useUIStore, type Toast } from "@/state/ui";
import { useSessionsStore } from "@/state/sessions";
import { useT } from "@/modules/i18n";
import { AgentBadge } from "./agents";
import { CloseIcon } from "./shared";
import { Check, CopySimple, Icon, Warning } from "@/ui/icons";
import { copyText } from "./lib/clipboard";
import { openResource, resourceRefForSession } from "@/modules/resources/resource-ref";

const DEFAULT_TOAST_DURATION = 4000;
const ERROR_TOAST_DURATION = 12000;

function ToastItem({ toast }: { toast: Toast }) {
  const t = useT();
  const removeToast = useUIStore((s) => s.removeToast);
  const setActive = useSessionsStore((s) => s.setActive);
  const [paused, setPaused] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const duration = toast.durationMs ?? (toast.variant === "error" ? ERROR_TOAST_DURATION : DEFAULT_TOAST_DURATION);
  const remainRef = useRef(duration);
  const startRef = useRef(Date.now());
  const dismissedRef = useRef(false);

  const dismiss = () => {
    if (dismissedRef.current) return;
    dismissedRef.current = true;
    removeToast(toast.id);
  };
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;

  useEffect(() => {
    startRef.current = Date.now();
    timerRef.current = setTimeout(() => dismissRef.current(), duration);
    return () => {
      clearTimeout(timerRef.current);
      clearTimeout(copiedTimerRef.current);
    };
  }, [duration]);

  const handleCopy = () => {
    const text = toast.subtitle ? `${toast.title}\n${toast.subtitle}` : toast.title;
    void copyText(text);
    setCopied(true);
    clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopied(false), 1200);
  };

  const pausedRef = useRef(false);
  const hoveredRef = useRef(false);
  const focusWithinRef = useRef(false);
  const pauseCountdown = () => {
    if (pausedRef.current) return;
    pausedRef.current = true;
    setPaused(true);
    clearTimeout(timerRef.current);
    remainRef.current -= Date.now() - startRef.current;
  };
  const resumeCountdown = () => {
    if (!pausedRef.current) return;
    pausedRef.current = false;
    setPaused(false);
    startRef.current = Date.now();
    timerRef.current = setTimeout(dismiss, Math.max(remainRef.current, 500));
  };

  const resumeWhenUnengaged = () => {
    if (!hoveredRef.current && !focusWithinRef.current) resumeCountdown();
  };

  const handleClick = () => {
    if (toast.action?.kind === "open-settings") {
      useUIStore.getState().openSettings(toast.action.tab);
    } else if (toast.action !== undefined && toast.action.kind === "open-remote-preview") {
      const previewAction = toast.action;
      const owner = useSessionsStore.getState().sessions.find((session) => session.id === previewAction.sessionId);
      if (owner) {
        void openResource(resourceRefForSession(owner, previewAction.path), "preview");
      }
    } else if (toast.sessionId) {
      setActive(toast.sessionId);
    }
    dismiss();
  };

  const accentColor = toast.variant === "success"
    ? "var(--c-success)"
    : toast.variant === "warning"
      ? "var(--c-warning)"
      : "var(--c-error)";

  return (
    <div
      className="toast-item"
      data-variant={toast.variant}
      data-paused={paused ? "true" : "false"}
      role={toast.variant === "error" ? "alert" : "status"}
      aria-live={toast.variant === "error" ? "assertive" : "polite"}
      onMouseEnter={() => { hoveredRef.current = true; pauseCountdown(); }}
      onMouseLeave={() => { hoveredRef.current = false; resumeWhenUnengaged(); }}
      onFocus={() => { focusWithinRef.current = true; pauseCountdown(); }}
      onBlur={(event) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        focusWithinRef.current = false;
        resumeWhenUnengaged();
      }}
      style={{
        width: "fit-content",
        minWidth: 260,
        maxWidth: "min(340px, calc(100vw - 24px))",
        background: "var(--c-bg-white)",
        border: "1px solid var(--c-border-1)",
        borderRadius: "var(--r-card)",
        boxShadow: "var(--shadow-notif)",
        padding: "10px 12px 8px 12px",
        display: "flex",
        alignItems: "center",
        gap: 9,
        cursor: "default",
        animation: "toastIn var(--duration-slow) var(--ease-out-back)",
        overflow: "hidden",
        position: "relative",
      }}
    >
      {(toast.action || toast.sessionId) && (
        <button
          type="button"
          onClick={handleClick}
          aria-label={toast.action?.label ?? `${toast.title}${toast.subtitle ? `, ${toast.subtitle}` : ""}`}
          className="toast-primary-action"
          style={{ position: "absolute", inset: 0, zIndex: 0, border: "none", background: "transparent", cursor: "pointer", borderRadius: "var(--r-card)" }}
        />
      )}

      <div style={{ display: "contents", pointerEvents: "none" }}>
      {toast.agentCode ? (
        <AgentBadge agent={toast.agentCode} size={22} />
      ) : toast.variant === "success" ? (
        <Icon icon={Check} size={14} color={accentColor} weight="bold" />
      ) : toast.variant === "warning" ? (
        <Icon icon={Warning} size={14} color={accentColor} weight="bold" />
      ) : (
        <CloseIcon size={14} strokeWidth={2.5} color={accentColor} />
      )}

      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="toast-title" style={{
          fontSize: "var(--fs-secondary)",
          fontWeight: 600,
          color: "var(--c-text-primary)",
          fontFamily: toast.agentCode ? "var(--font-ui)" : "var(--font-mono)",
        }}>
          {toast.title}
        </div>
        {toast.subtitle ? (
          <div className="toast-subtitle" style={{
            fontSize: "var(--fs-meta)",
            color: "var(--c-text-5)",
            marginTop: 1,
          }}>
            {toast.subtitle}
          </div>
        ) : null}
      </div>
      </div>

      {toast.action && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            handleClick();
          }}
          className="hover-accent-bg"
          style={{
            position: "relative",
            zIndex: 1,
            height: 26,
            padding: "0 9px",
            borderRadius: "var(--r-btn)",
            border: "1px solid var(--c-accent-border)",
            background: "var(--c-accent-bg-soft)",
            color: "var(--c-accent)",
            fontSize: "var(--fs-meta)",
            fontWeight: 700,
            cursor: "pointer",
            flexShrink: 0,
          }}
        >
          {toast.action.label}
        </button>
      )}

      {toast.variant === "error" && (
        <button
          onClick={(e) => { e.stopPropagation(); handleCopy(); }}
          title={t(copied ? "toast.copied" : "toast.copy_error")}
          aria-label={t(copied ? "toast.copied" : "toast.copy_error")}
          style={{
            position: "relative",
            zIndex: 1,
            width: 18,
            height: 18,
            borderRadius: 4,
            border: "none",
            background: "transparent",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
            color: copied ? "var(--c-success)" : "var(--c-text-5)",
          }}
          className="hover-bg"
        >
          {copied ? (
            <Icon icon={Check} size={11} weight="bold" />
          ) : (
            <Icon icon={CopySimple} size={11} />
          )}
        </button>
      )}

      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); dismiss(); }}
        aria-label={t("common.close")}
        style={{
          position: "relative",
          zIndex: 1,
          width: 18,
          height: 18,
          borderRadius: 4,
          border: "none",
          background: "transparent",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          color: "var(--c-text-5)",
        }}
        className="hover-close"
      >
        <CloseIcon size={10} strokeWidth={2.5} />
      </button>
    </div>
  );
}

export function ToastContainer() {
  const t = useT();
  const toasts = useUIStore((s) => s.toasts);
  if (toasts.length === 0) return null;

  return (
    <div
      role="region"
      aria-label={t("toast.region")}
      style={{
      position: "fixed",
      top: "calc(var(--h-titlebar) + 8px)",
      right: 12,
      zIndex: 300,
      display: "flex",
      flexDirection: "column",
      gap: 8,
      pointerEvents: "auto",
    }}>
      {toasts.map((toastItem) => (
        <ToastItem key={toastItem.id} toast={toastItem} />
      ))}
    </div>
  );
}
