import { useEffect, useRef, useState } from "react";
import { useUIStore, type Toast } from "@/state/ui";
import { useSessionsStore } from "@/state/sessions";
import { useT } from "@/modules/i18n";
import { AgentBadge } from "./agents";
import { CloseIcon } from "./shared";
import { copyText } from "./lib/clipboard";

const TOAST_DURATION = 4000;
const EXIT_DURATION = 250;

function ToastItem({ toast }: { toast: Toast }) {
  const t = useT();
  const removeToast = useUIStore((s) => s.removeToast);
  const setActive = useSessionsStore((s) => s.setActive);
  const [exiting, setExiting] = useState<boolean>(false);
  const [paused, setPaused] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const remainRef = useRef(TOAST_DURATION);
  const startRef = useRef(Date.now());
  const exitingRef = useRef(false);

  const dismiss = () => {
    if (exitingRef.current) return;
    exitingRef.current = true;
    setExiting(true);
    exitTimerRef.current = setTimeout(() => removeToast(toast.id), EXIT_DURATION);
  };
  // The mount effect below runs once by design; holding dismiss in a ref keeps
  // its dependency list honestly empty while the timer still calls the latest
  // closure (same pattern as sessionIdRef in TerminalView).
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;

  useEffect(() => {
    startRef.current = Date.now();
    timerRef.current = setTimeout(() => dismissRef.current(), TOAST_DURATION);
    return () => {
      clearTimeout(timerRef.current);
      clearTimeout(exitTimerRef.current);
      clearTimeout(copiedTimerRef.current);
    };
  }, []);

  const handleCopy = () => {
    const text = toast.subtitle ? `${toast.title}\n${toast.subtitle}` : toast.title;
    void copyText(text);
    setCopied(true);
    clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopied(false), 1200);
  };

  const handleMouseEnter = () => {
    setPaused(true);
    clearTimeout(timerRef.current);
    remainRef.current -= Date.now() - startRef.current;
  };

  const handleMouseLeave = () => {
    setPaused(false);
    startRef.current = Date.now();
    timerRef.current = setTimeout(dismiss, Math.max(remainRef.current, 500));
  };

  const handleClick = () => {
    if (toast.sessionId) setActive(toast.sessionId);
    dismiss();
  };

  const accentColor = toast.variant === "success"
    ? "var(--c-success)"
    : toast.variant === "warning"
      ? "var(--c-warning)"
      : "var(--c-error)";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => e.key === "Enter" && handleClick()}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={{
        width: "fit-content",
        minWidth: 260,
        maxWidth: "min(340px, calc(100vw - 24px))",
        background: "var(--c-bg-white-glass)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        border: "1px solid var(--c-border-1)",
        borderRadius: "var(--r-card)",
        boxShadow: "var(--shadow-notif)",
        borderLeft: `3px solid ${accentColor}`,
        padding: "10px 12px 8px 12px",
        display: "flex",
        alignItems: "center",
        gap: 9,
        cursor: "pointer",
        animation: exiting
          ? `toastOut ${EXIT_DURATION}ms var(--ease-smooth) forwards`
          : "toastIn var(--duration-slow) var(--ease-out-back)",
        overflow: "hidden",
        position: "relative",
      }}
    >
      {toast.agentCode ? (
        <AgentBadge agent={toast.agentCode} size={22} />
      ) : toast.variant === "success" ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={accentColor} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : toast.variant === "warning" ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={accentColor} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      ) : (
        <CloseIcon size={14} strokeWidth={2.5} color={accentColor} />
      )}

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: "var(--fs-secondary)",
          fontWeight: 600,
          color: "var(--c-text-primary)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontFamily: toast.agentCode ? "var(--font-ui)" : "var(--font-mono)",
        }}>
          {toast.title}
        </div>
        <div style={{
          fontSize: "var(--fs-meta)",
          color: "var(--c-text-5)",
          marginTop: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}>
          {toast.subtitle}
        </div>
      </div>

      {toast.variant === "error" && (
        <button
          onClick={(e) => { e.stopPropagation(); handleCopy(); }}
          title={t(copied ? "toast.copied" : "toast.copy_error")}
          aria-label={t(copied ? "toast.copied" : "toast.copy_error")}
          style={{
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
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </button>
      )}

      <button
        onClick={(e) => { e.stopPropagation(); dismiss(); }}
        style={{
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

      {/* Progress bar */}
      <div style={{
        position: "absolute",
        bottom: 0,
        left: 0,
        right: 0,
        height: 2,
        background: "var(--c-border-1)",
        overflow: "hidden",
      }}>
        <div style={{
          height: "100%",
          background: accentColor,
          opacity: 0.5,
          transformOrigin: "left",
          animation: paused ? "none" : `toastProgress ${TOAST_DURATION}ms linear forwards`,
          animationPlayState: paused ? "paused" : "running",
        }} />
      </div>
    </div>
  );
}

export function ToastContainer() {
  const toasts = useUIStore((s) => s.toasts);
  if (toasts.length === 0) return null;

  return (
    <div style={{
      position: "fixed",
      top: "calc(var(--h-titlebar) + 8px)",
      right: 12,
      zIndex: 300,
      display: "flex",
      flexDirection: "column",
      gap: 8,
      pointerEvents: "auto",
    }}>
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}
