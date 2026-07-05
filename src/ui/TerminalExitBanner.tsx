import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { useT } from "@/modules/i18n";
import { t as staticT } from "@/modules/i18n";
import type { Session } from "./types";

interface TerminalExitBannerProps {
  session: Session;
  exitCode: number;
}

/**
 * Overlay shown after the PTY process exits. Without it the terminal is a dead
 * pane with a single grey "[process exited: N]" line and no obvious next step.
 * Offers "Restart in this directory" (local) / "Reconnect" (remote). Replacing
 * the session in place keeps the sidebar grouping and split layout stable.
 */
export function TerminalExitBanner({ session, exitCode }: TerminalExitBannerProps) {
  const t = useT();
  const isRemote = !!session.remote;

  const restart = () => {
    const store = useSessionsStore.getState();
    if (isRemote && session.remote) {
      // Remote: route the user back to the SSH dialog pre-filled with the host
      // profile. Credentials were one-shot and never persisted, so we cannot
      // re-stash them here — the user re-enters them in the dialog.
      useUIStore.getState().openSshConnect({
        host: session.remote.host,
        user: session.remote.user,
        port: session.remote.port,
      });
      store.closeSession(session.id);
      return;
    }
    // Local: spawn a fresh terminal in the same cwd, then drop the dead one.
    store.newTerminalInDir(session.dir);
    store.closeSession(session.id);
  };

  const tone = exitCode === 0 ? "var(--c-success)" : "var(--c-error)";
  const label = exitCode === 0
    ? t("terminal.exited.ok")
    : t("terminal.exited.failed", { code: exitCode });
  const actionLabel = isRemote ? t("terminal.exited.reconnect") : t("terminal.exited.restart");

  return (
    <div
      style={{
        position: "absolute",
        left: 8,
        right: 8,
        bottom: 8,
        flexShrink: 0,
        background: "var(--c-bg-1)",
        border: "1px solid var(--c-border-1)",
        borderRadius: "var(--r-btn)",
        display: "flex",
        alignItems: "center",
        padding: "0 10px",
        gap: 8,
        boxShadow: "var(--shadow-card)",
        animation: "statusBarSlideIn var(--duration-normal) var(--ease-out-expo)",
        zIndex: 5,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: tone,
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontSize: "var(--fs-meta)",
          color: "var(--c-text-2)",
          lineHeight: "16px",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
          minWidth: 0,
        }}
      >
        {label}
      </span>
      <button
        onClick={restart}
        className="hover-accent-bg"
        title={actionLabel}
        aria-label={actionLabel}
        style={{
          height: 22,
          flexShrink: 0,
          borderRadius: "var(--r-btn)",
          border: "1px solid var(--c-accent-border)",
          background: "var(--c-accent-bg-soft)",
          color: "var(--c-accent)",
          fontSize: "var(--fs-meta)",
          fontWeight: 600,
          cursor: "pointer",
          padding: "0 10px",
          display: "flex",
          alignItems: "center",
          gap: 4,
          transition: "background var(--duration-fast) var(--ease-smooth)",
        }}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
        </svg>
        {actionLabel}
      </button>
    </div>
  );
}

interface PtyErrorBannerProps {
  session: Session;
}

/**
 * Banner shown when the local PTY failed to open (B2). Without it the only
 * signal was a silent red inline line in the dead pane. The retry action
 * spawns a fresh terminal in the same cwd, mirroring the exit banner.
 */
export function PtyErrorBanner({ session }: PtyErrorBannerProps) {
  const t = useT();
  const isRemote = !!session.remote;

  const retry = () => {
    const store = useSessionsStore.getState();
    if (isRemote) {
      // Remote open failure: route back to the SSH dialog so the user can
      // re-enter credentials (one-shot, never persisted).
      if (session.remote) {
        useUIStore.getState().openSshConnect({
          host: session.remote.host,
          user: session.remote.user,
          port: session.remote.port,
        });
      }
      store.closeSession(session.id);
      return;
    }
    store.newTerminalInDir(session.dir);
    store.closeSession(session.id);
  };

  return (
    <div
      style={{
        position: "absolute",
        left: 8,
        right: 8,
        bottom: 8,
        flexShrink: 0,
        background: "var(--c-bg-1)",
        border: "1px solid var(--c-border-1)",
        borderRadius: "var(--r-btn)",
        display: "flex",
        alignItems: "center",
        padding: "0 10px",
        gap: 8,
        boxShadow: "var(--shadow-card)",
        animation: "statusBarSlideIn var(--duration-normal) var(--ease-out-expo)",
        zIndex: 5,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          background: "var(--c-error)",
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontSize: "var(--fs-meta)",
          color: "var(--c-text-2)",
          lineHeight: "16px",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
          minWidth: 0,
        }}
      >
        {t("pty.error.title")} — {t("pty.error.subtitle")}
      </span>
      <button
        onClick={retry}
        className="hover-accent-bg"
        title={t("pty.error.retry")}
        aria-label={t("pty.error.retry")}
        style={{
          height: 22,
          flexShrink: 0,
          borderRadius: "var(--r-btn)",
          border: "1px solid var(--c-accent-border)",
          background: "var(--c-accent-bg-soft)",
          color: "var(--c-accent)",
          fontSize: "var(--fs-meta)",
          fontWeight: 600,
          cursor: "pointer",
          padding: "0 10px",
          display: "flex",
          alignItems: "center",
          gap: 4,
          transition: "background var(--duration-fast) var(--ease-smooth)",
        }}
      >
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
        </svg>
        {t("pty.error.retry")}
      </button>
    </div>
  );
}

/**
 * Lightweight "connecting" overlay shown between session creation and PTY
 * open (B4). SSH handshakes can take a few seconds; without this the terminal
 * pane is blank with no signal. Lifted out of TerminalView to keep that file
 * under its regression-tested line budget.
 */
export function ConnectingOverlay() {
  return (
    <div
      aria-live="polite"
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "none",
        background: "var(--c-bg-white)",
        animation: "fadeIn var(--duration-normal) var(--ease-smooth)",
        zIndex: 4,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--c-accent)", animation: "pulseDot 1.2s var(--ease-in-out) infinite" }} />
        <span style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)" }}>
          {staticT("ssh.connecting")}
        </span>
      </div>
    </div>
  );
}
