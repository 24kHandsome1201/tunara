import type { SessionCue } from "@/modules/session/session-attention";
import type { RunState } from "./types";

export type SessionDotTone = "ok" | "warn" | "err" | "attention" | "unread";

/**
 * The one status slot on session cards and directory group headers.
 * Accent is reserved for "needs you"; running is a still green-gray;
 * failed is muted red; idle has no dot.
 */
export function sessionDotTone(
  cue: SessionCue | null,
  runState?: RunState,
): SessionDotTone | null {
  if (cue === "needs-you") return "attention";
  if (runState === "failed") return "err";
  if (runState === "running") return "ok";
  if (cue === "unread") return "unread";
  return null;
}

export function SessionCueDot({
  cue,
  overlay = false,
  runState,
}: {
  cue: SessionCue | null;
  overlay?: boolean;
  runState?: RunState;
}) {
  const tone = sessionDotTone(cue, runState);
  if (!tone) return null;
  return (
    <span
      data-session-cue={cue ?? undefined}
      data-tone={tone}
      aria-hidden="true"
      className="session-state-dot"
      style={{
        ...(overlay
          ? { position: "absolute", bottom: -1, right: -1 }
          : { flexShrink: 0 }),
        width: overlay ? 8 : 6,
        height: overlay ? 8 : 6,
        border: overlay ? "2px solid var(--c-bg-white)" : undefined,
      }}
    />
  );
}
