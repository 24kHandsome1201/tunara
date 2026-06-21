import { useUIStore, type Toast } from "@/state/ui";
import { useSessionsStore } from "@/state/sessions";
import { AgentBadge } from "./agents";

function ToastItem({ toast }: { toast: Toast }) {
  const removeToast = useUIStore((s) => s.removeToast);
  const setActive = useSessionsStore((s) => s.setActive);

  const handleClick = () => {
    setActive(toast.sessionId);
    removeToast(toast.id);
  };

  const accentColor = toast.variant === "success" ? "var(--c-success)" : "var(--c-error)";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={(e) => e.key === "Enter" && handleClick()}
      style={{
        width: 260,
        background: "var(--c-bg-white-glass)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        border: "1px solid var(--c-border-1)",
        borderRadius: "var(--r-card)",
        boxShadow: "var(--shadow-notif)",
        padding: "10px 12px",
        display: "flex",
        alignItems: "center",
        gap: 10,
        cursor: "pointer",
        animation: "toastIn var(--duration-normal) ease",
        transition: "opacity var(--duration-fast) ease",
      }}
    >
      <div style={{ width: 3, alignSelf: "stretch", borderRadius: 2, background: accentColor, flexShrink: 0 }} />

      {toast.agentCode ? (
        <AgentBadge agent={toast.agentCode} size={22} />
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={accentColor} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
          {toast.variant === "success" ? (
            <polyline points="20 6 9 17 4 12" />
          ) : (
            <>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </>
          )}
        </svg>
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
        }}>
          {toast.subtitle}
        </div>
      </div>

      <button
        onClick={(e) => { e.stopPropagation(); removeToast(toast.id); }}
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
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}

export function ToastContainer() {
  const toasts = useUIStore((s) => s.toasts);
  if (toasts.length === 0) return null;

  return (
    <div style={{
      position: "fixed",
      bottom: "calc(var(--h-statusbar) + 12px)",
      right: 12,
      zIndex: 300,
      display: "flex",
      flexDirection: "column-reverse",
      gap: 8,
      pointerEvents: "auto",
    }}>
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  );
}
