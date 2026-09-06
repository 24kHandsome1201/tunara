import { useMemo } from "react";
import type { Session } from "./types";
import { deriveAttentionRow, nextAttentionSessionId } from "@/modules/session/session-attention";
import { useT } from "@/modules/i18n";
import { revealSessionAttention } from "@/modules/terminal/lib/terminal-action-registry";

interface AttentionRowProps {
  sessions: Session[];
  onSelectSession: (id: string) => void;
}

/**
 * Sidebar spine: at most one row, one fact, one action. Terracotta is
 * reserved for "needs you"; running is muted; nothing renders otherwise.
 */
export function AttentionRow({ sessions, onSelectSession }: AttentionRowProps) {
  const t = useT();
  const row = useMemo(() => deriveAttentionRow(sessions), [sessions]);

  if (!row.kind) return null;

  const label = row.kind === "needs-you"
    ? t("attention.row.needs_you", { count: row.count })
    : t("attention.row.running", { count: row.count });
  const emphasized = row.kind === "needs-you";
  const targetId = nextAttentionSessionId(sessions, null)
    ?? (row.kind === "running" ? [...sessions].filter((s) => s.agentActivity === "running" || s.agentActivity === "starting").sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id : null);
  const target = sessions.find((s) => s.id === targetId);
  const reason = target && emphasized ? t(target.connection?.phase === "disconnected" || target.connection?.phase === "failed" || target.connection?.phase === "needsUserAction"
    ? "attention.reason.connection" : target.agentActivity === "waiting_confirmation" ? "attention.reason.confirmation" : "attention.reason.failure") : "";

  return (
    <div style={{ padding: "2px 12px 6px", flexShrink: 0 }}>
      <button
        type="button"
        onClick={() => {
          if (targetId) { onSelectSession(targetId); revealSessionAttention(targetId); }
        }}
        aria-label={label}
        aria-description={reason || undefined}
        title={target ? `${target.customTitle || target.title} · ${reason || label}` : label}
        className="attention-row-button"
        data-kind={row.kind}
        style={{
          width: "100%",
          height: 30,
          border: "none",
          background: "transparent",
          display: "flex",
          alignItems: "center",
          padding: "0 8px 0 10px",
          cursor: "pointer",
          userSelect: "none",
          fontFamily: "var(--font-ui)",
          fontSize: "var(--fs-secondary)",
          fontWeight: emphasized ? 700 : 500,
          color: emphasized ? "var(--c-accent)" : "var(--c-text-5)",
          letterSpacing: emphasized ? "0.01em" : undefined,
        }}
      >
        {label}
        {reason && <span style={{ marginLeft: "auto", paddingLeft: 8, fontWeight: 400, fontSize: "var(--fs-meta)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{reason}</span>}
      </button>
    </div>
  );
}
