import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { useT } from "@/modules/i18n";
import { t as staticT } from "@/modules/i18n";
import { SSH_DISCONNECTED_EXIT_CODE, sshFailureReason } from "@/modules/terminal/lib/pty-bridge";
import type { Session } from "./types";
import { AccentActionButton, RestartIcon } from "./lib/ui-primitives";
import { connectionDiagnostic, type ConnectionPhase } from "@/modules/terminal/lib/connection-state";
import { copyText } from "./lib/clipboard";

function ConnectionDiagnosticButton({ session }: { session: Session }) {
  const t = useT();
  const copy = async () => {
    const endpoint = session.remote
      ? `${session.remote.user}@${session.remote.host}:${session.remote.port}`
      : undefined;
    const ok = await copyText(connectionDiagnostic({
      sessionId: session.id,
      endpoint,
      evidence: session.connection,
    }));
    useUIStore.getState().addToast({
      sessionId: session.id,
      title: ok ? t("connection.diagnostics.copied") : t("toast.copy_error"),
      subtitle: "",
      variant: ok ? "success" : "error",
    });
  };
  return (
    <button
      type="button"
      onClick={() => { void copy(); }}
      className="hover-bg"
      style={{ border: "none", background: "transparent", color: "var(--c-text-4)", cursor: "pointer", fontSize: "var(--fs-meta)", padding: "4px 6px", borderRadius: "var(--r-btn)", flexShrink: 0 }}
    >
      {t("connection.diagnostics.copy")}
    </button>
  );
}

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
      // Keep the dead session and its snapshot until the replacement is
      // configured. Cancelling the dialog must not destroy notes, split
      // placement, or scrollback.
      useUIStore.getState().openSshConnect({
        host: session.remote.host,
        user: session.remote.user,
        port: session.remote.port,
        identityFile: session.remote.identityFile,
        injectShellIntegration: session.remote.injectShellIntegration,
        reconnectSessionId: session.id,
      });
      return;
    }
    // Local: spawn a fresh terminal in the same cwd, then drop the dead one.
    store.newTerminalInDir(session.dir);
    store.closeSession(session.id);
  };

  const disconnected = isRemote && exitCode === SSH_DISCONNECTED_EXIT_CODE;
  const tone = disconnected ? "var(--c-warning)" : exitCode === 0 ? "var(--c-success)" : "var(--c-error)";
  const label = disconnected
    ? t("terminal.exited.disconnected")
    : exitCode === 0
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
      {isRemote && <ConnectionDiagnosticButton session={session} />}
      <AccentActionButton onClick={restart} title={actionLabel} ariaLabel={actionLabel}>
        <RestartIcon size={10} />
        {actionLabel}
      </AccentActionButton>
    </div>
  );
}

interface PtyErrorBannerProps {
  session: Session;
  error: string;
}

/**
 * Banner shown when the local PTY failed to open (B2). Without it the only
 * signal was a silent red inline line in the dead pane. The retry action
 * spawns a fresh terminal in the same cwd, mirroring the exit banner.
 */
export function PtyErrorBanner({ session, error }: PtyErrorBannerProps) {
  const t = useT();
  const isRemote = !!session.remote;
  const title = isRemote ? t("ssh.error.title") : t("pty.error.title");
  const detail = isRemote ? sshFailureReason(error) : t("pty.error.subtitle");
  const phase = session.connection?.failedAtPhase;
  const phaseLabel = phase ? t(`connection.phase.${phase}`) : "";
  const summary = phaseLabel ? `${title} · ${phaseLabel} · ${detail}` : `${title} · ${detail}`;

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
          identityFile: session.remote.identityFile,
          injectShellIntegration: session.remote.injectShellIntegration,
          reconnectSessionId: session.id,
        });
      }
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
        {summary}
      </span>
      <ConnectionDiagnosticButton session={session} />
      <AccentActionButton onClick={retry} title={t("pty.error.retry")} ariaLabel={t("pty.error.retry")}>
        <RestartIcon size={10} />
        {t("pty.error.retry")}
      </AccentActionButton>
    </div>
  );
}

/**
 * Lightweight "connecting" overlay shown between session creation and PTY
 * open (B4). SSH handshakes can take a few seconds; without this the terminal
 * pane is blank with no signal. Lifted out of TerminalView to keep that file
 * under its regression-tested line budget.
 */
export function ConnectingOverlay({ phase, onCancel }: { phase?: ConnectionPhase; onCancel?: () => void }) {
  const label = staticT(`connection.phase.${phase ?? "connecting"}`);
  return (
    <div
      aria-live="polite"
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: onCancel ? "auto" : "none",
        background: "var(--c-bg-white)",
        animation: "fadeIn var(--duration-normal) var(--ease-smooth)",
        zIndex: 4,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--c-accent)", animation: "loadPulse 1.5s var(--ease-in-out) infinite" }} />
        <span style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)" }}>
          {label}
        </span>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="hover-accent-bg"
            style={{
              marginTop: 4,
              padding: "4px 12px",
              borderRadius: "var(--r-btn)",
              border: "1px solid var(--c-accent-border)",
              background: "var(--c-accent-bg-soft)",
              color: "var(--c-accent)",
              fontSize: "var(--fs-secondary)",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {staticT("ssh.connecting.close_session")}
          </button>
        )}
      </div>
    </div>
  );
}
