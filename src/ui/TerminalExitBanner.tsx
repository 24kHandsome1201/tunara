import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { useT } from "@/modules/i18n";
import { SSH_DISCONNECTED_EXIT_CODE } from "@/modules/terminal/lib/pty-bridge";
import { reconnectPrefillFromSession, type Session } from "./types";
import { AccentActionButton, RestartIcon } from "./lib/ui-primitives";
import { connectionDiagnostic, type ConnectionPhase } from "@/modules/terminal/lib/connection-state";
import { copyText } from "./lib/clipboard";
import { diagnosticReportText } from "@/modules/ssh/diagnostics-bridge";
import { SessionRemediationNotice, useSessionRemediationAction } from "./SessionRemediationNotice";

/**
 * banner 挂载时：把焦点从死终端的 xterm textarea 挪到 banner 主操作按钮
 * （重启/重连），键盘用户不用 Tab 完整圈终端才能到达动作。
 */
/** Spawn a fresh local terminal in the dead session's cwd and drop the dead
 * one. The dead session is activated first so the replacement takes over its
 * split pane instead of whichever pane happened to be active. */
function restartLocalInPlace(session: Session) {
  const store = useSessionsStore.getState();
  store.setActive(session.id);
  store.newTerminalInDir(session.dir);
  store.closeSession(session.id);
}

function useFocusPrimaryActionOnMount() {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const scope = root.closest("[data-terminal-session-id]");
    const focused = document.activeElement;
    // An inactive split can fail while the user is typing elsewhere. Move
    // focus only when it was already inside this terminal's dead textarea.
    if (!scope || !(focused instanceof HTMLTextAreaElement) || !scope.contains(focused)) return;
    focused.blur();
    const buttons = root.querySelectorAll<HTMLElement>("button");
    buttons[buttons.length - 1]?.focus();
  }, []);
  return rootRef;
}

function ConnectionDiagnosticButton({ session }: { session: Session }) {
  const t = useT();
  const copy = async () => {
    const ok = await copyText(session.remote ? diagnosticReportText(session.id) : connectionDiagnostic({
      sessionId: session.id,
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
      style={{ border: "none", background: "transparent", color: "var(--c-text-4)", cursor: "pointer", fontSize: "var(--fs-meta)", padding: "4px 6px", borderRadius: "var(--r-btn)", flexShrink: 0, whiteSpace: "nowrap" }}
    >
      {t("connection.diagnostics.copy")}
    </button>
  );
}

function CloseSessionButton({ session }: { session: Session }) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={() => { useSessionsStore.getState().closeSession(session.id); }}
      className="hover-bg"
      style={{ border: "1px solid var(--c-border-1)", background: "transparent", color: "var(--c-text-3)", cursor: "pointer", fontSize: "var(--fs-meta)", padding: "4px 8px", borderRadius: "var(--r-btn)", flexShrink: 0, whiteSpace: "nowrap" }}
    >
      {t("terminal.exited.close_session")}
    </button>
  );
}

/**
 * Shared pane-bar layout for dead terminals. The status label stays on one
 * line and truncates (full text in `title`) so narrow panes never break short
 * CJK labels mid-word; the action group wraps as a unit to the next row. The
 * primary action must stay the last button: pane activation and attention
 * reveal focus the last button inside the `[role="alert"]` bar. Like the
 * restored-history notice it sits in the pane's flex column, so the terminal
 * refits above it instead of hiding the final rows (e.g. `logout`).
 */
function PaneRecoveryBar({ rootRef, role, tone, label, context, children }: {
  rootRef: RefObject<HTMLDivElement | null>;
  role: "alert" | "status";
  tone: string;
  label: string;
  context?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      ref={rootRef}
      role={role}
      aria-atomic="true"
      data-pane-recovery-bar
      style={{
        position: "relative",
        flexShrink: 0,
        margin: "0 8px 8px",
        background: "var(--c-bg-1)",
        border: "1px solid var(--c-border-1)",
        borderRadius: "var(--r-btn)",
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        padding: "6px 10px",
        columnGap: 12,
        rowGap: 6,
        boxShadow: "var(--shadow-card)",
        animation: "statusBarSlideIn var(--dur-base) var(--ease-out)",
        zIndex: 5,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flex: "1 1 12em", minWidth: 0 }}>
        <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: "50%", background: tone, flexShrink: 0 }} />
        <span
          title={label}
          style={{
            fontSize: "var(--fs-meta)",
            color: "var(--c-text-2)",
            lineHeight: "16px",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: "1 1 auto",
            minWidth: 0,
          }}
        >
          {label}
        </span>
        {context}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end", gap: 8, marginLeft: "auto" }}>
        {children}
      </div>
    </div>
  );
}

interface TerminalExitBannerProps {
  session: Session;
  exitCode: number;
}

/**
 * Shown once after a restored terminal becomes ready; history is not a live
 * process. Rendered in the pane's flex column (not over the canvas) so the
 * terminal shrinks and refits instead of hiding a full-screen TUI's bottom rows.
 */
export function RestoredHistoryNotice({ remote, onDismiss }: { remote: boolean; onDismiss: () => void }) {
  const t = useT();
  const label = t(remote ? "terminal.history.remote_ready" : "terminal.history.local_ready");
  return (
    <div role="status" data-restored-history-notice style={{ flexShrink: 0, margin: "0 8px 8px", display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", border: "1px solid var(--c-border-1)", borderRadius: "var(--r-btn)", background: "var(--c-bg-1)", color: "var(--c-text-4)", fontSize: "var(--fs-secondary)" }}>
      <span title={label} style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      <button type="button" className="ui-button" onClick={onDismiss} style={{ flexShrink: 0, whiteSpace: "nowrap" }}>{t("common.done")}</button>
    </div>
  );
}

/**
 * Overlay shown after the PTY process exits. Without it the terminal is a dead
 * pane with a single grey "[process exited: N]" line and no obvious next step.
 * Offers "Restart in this directory" (local) / "Reconnect" (remote). Replacing
 * the session in place keeps the sidebar grouping and split layout stable.
 * A pending SSH remediation owns the single primary action; its notice only
 * adds context so the bar never shows two "Reconnect" buttons.
 */
export function TerminalExitBanner({ session, exitCode }: TerminalExitBannerProps) {
  const t = useT();
  const isRemote = !!session.remote;
  const rootRef = useFocusPrimaryActionOnMount();
  const remediation = useSessionRemediationAction(session);

  const restart = () => {
    if (isRemote && session.remote) {
      // Keep the dead session and its snapshot until the replacement is
      // configured. Cancelling the dialog must not destroy split
      // placement, or scrollback.
      useUIStore.getState().openSshConnect(reconnectPrefillFromSession(session));
      return;
    }
    restartLocalInPlace(session);
  };

  const disconnected = isRemote && exitCode === SSH_DISCONNECTED_EXIT_CODE;
  const tone = disconnected ? "var(--c-warning)" : exitCode === 0 ? "var(--c-success)" : "var(--c-error)";
  const label = disconnected
    ? t("terminal.exited.disconnected")
    : exitCode === 0
      ? t("terminal.exited.ok")
      : t("terminal.exited.failed", { code: exitCode });
  const visibleLabel = disconnected
    ? `${label} · ${t("terminal.exited.history_readonly")}`
    : label;
  const actionLabel = remediation?.label ?? (isRemote
    ? disconnected ? t("terminal.exited.reconnect") : t("terminal.exited.open_new_shell")
    : t("terminal.exited.restart"));

  return (
    <PaneRecoveryBar
      rootRef={rootRef}
      role={disconnected || exitCode !== 0 ? "alert" : "status"}
      tone={tone}
      label={visibleLabel}
      context={<SessionRemediationNotice session={session} compact showAction={false} />}
    >
      {isRemote && <ConnectionDiagnosticButton session={session} />}
      <CloseSessionButton session={session} />
      <AccentActionButton onClick={remediation?.run ?? restart} title={actionLabel} ariaLabel={actionLabel}>
        <RestartIcon size={10} />
        {actionLabel}
      </AccentActionButton>
    </PaneRecoveryBar>
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
  const rootRef = useFocusPrimaryActionOnMount();
  const remediation = useSessionRemediationAction(session);
  const title = isRemote ? t("ssh.error.title") : t("pty.error.title");
  const detail = isRemote ? error : t("pty.error.subtitle");
  const phase = session.connection?.failedAtPhase;
  const phaseLabel = phase ? t(`connection.phase.${phase}`) : "";
  const summary = phaseLabel ? `${title} · ${phaseLabel} · ${detail}` : `${title} · ${detail}`;
  const retryLabel = remediation?.label ?? t("pty.error.retry");

  const retry = () => {
    if (isRemote) {
      // Remote open failure: route back to the SSH dialog so the user can
      // re-enter credentials (one-shot, never persisted).
      if (session.remote) {
        useUIStore.getState().openSshConnect(reconnectPrefillFromSession(session));
      }
      return;
    }
    restartLocalInPlace(session);
  };

  return (
    <PaneRecoveryBar
      rootRef={rootRef}
      role="alert"
      tone="var(--c-error)"
      label={summary}
      context={<SessionRemediationNotice session={session} compact showAction={false} />}
    >
      <ConnectionDiagnosticButton session={session} />
      <CloseSessionButton session={session} />
      <AccentActionButton onClick={remediation?.run ?? retry} title={retryLabel} ariaLabel={retryLabel}>
        <RestartIcon size={10} />
        {retryLabel}
      </AccentActionButton>
    </PaneRecoveryBar>
  );
}

/**
 * Lightweight "connecting" overlay shown between session creation and PTY
 * open (B4). SSH handshakes can take a few seconds; without this the terminal
 * pane is blank with no signal. Lifted out of TerminalView to keep that file
 * under its regression-tested line budget.
 */
export function ConnectingOverlay({
  phase,
  onCancel,
}: {
  phase?: ConnectionPhase;
  onCancel?: () => void;
}) {
  const t = useT();
  const label = t(`connection.phase.${phase ?? "connecting"}`);
  const cancelLabel = t("ssh.connecting.close_session");
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: onCancel ? "auto" : "none",
        // 半透明：让快照恢复中的终端内容透出来，连接过程不再是一块死白
        background: "color-mix(in srgb, var(--terminal-canvas-bg, var(--c-bg-white)) 78%, transparent)",
        animation: "fadeIn var(--dur-base) var(--ease-out)",
        zIndex: 4,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--c-accent)" }} />
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
            {cancelLabel}
          </button>
        )}
      </div>
    </div>
  );
}
