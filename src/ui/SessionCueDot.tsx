import type { SessionCue } from "@/modules/session/session-attention";

/**
 * The one status slot on session cards and directory group headers.
 * Terracotta is reserved for "needs you"; unread is a muted neutral dot.
 */
export function SessionCueDot({
  cue,
  overlay = false,
}: {
  cue: SessionCue | null;
  overlay?: boolean;
}) {
  if (!cue) return null;
  const needsYou = cue === "needs-you";
  return (
    <span
      data-session-cue={cue}
      aria-hidden="true"
      style={{
        ...(overlay
          ? { position: "absolute", bottom: -1, right: -1 }
          : { flexShrink: 0 }),
        width: overlay ? 8 : 6,
        height: overlay ? 8 : 6,
        borderRadius: "50%",
        background: needsYou ? "var(--c-accent)" : "var(--c-text-5)",
        border: overlay ? "2px solid var(--c-bg-white)" : undefined,
        animation: "scaleIn var(--duration-fast) var(--ease-out-expo)",
      }}
    />
  );
}
