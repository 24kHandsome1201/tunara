import { useRef, useState } from "react";
import { useUIStore } from "@/state/ui";
import { useT } from "@/modules/i18n";
import { answerHostKeyPrompt } from "@/modules/terminal/lib/pty-bridge";
import { useModalBehavior } from "./Modal";

/**
 * App-level dialog shown when an SSH connection meets an unknown / unverifiable
 * host key (TOFU). The backend `ssh_open_v2` call is blocked inside
 * `check_server_key` until the user accepts or rejects the fingerprint.
 */
export function HostKeyPromptDialog() {
  const t = useT();
  // Render the head of the queue; answering it advances to the next pending
  // prompt (if two hosts prompted before the first was answered).
  const prompt = useUIStore((s) => s.hostKeyPrompts[0] ?? null);
  const dismissHostKeyPrompt = useUIStore((s) => s.dismissHostKeyPrompt);
  const dialogRef = useRef<HTMLDivElement>(null);
  const rejectRef = useRef<HTMLButtonElement>(null);
  const [submitting, setSubmitting] = useState(false);

  const decide = async (accept: boolean) => {
    if (!prompt || submitting) return;
    setSubmitting(true);
    try {
      await answerHostKeyPrompt(prompt.promptId, accept);
      dismissHostKeyPrompt(prompt.promptId);
    } catch {
      useUIStore.getState().addToast({
        title: t("ssh.hostKey.decision_failed"),
        subtitle: "",
        variant: "error",
      });
    } finally {
      setSubmitting(false);
    }
  };

  useModalBehavior(dialogRef, {
    active: prompt !== null,
    initialFocus: rejectRef,
    bindingKey: prompt?.promptId,
    currentBindingKey: prompt?.promptId,
    onRequestClose: () => { void decide(false); },
  });

  if (!prompt) return null;

  const hostLabel = prompt.port === 22 ? prompt.host : `${prompt.host}:${prompt.port}`;
  // "unverifiable" = a relevant record (for example @cert-authority or a
  // malformed hash) cannot be evaluated safely — a possible key rotation or
  // MITM. This path deliberately does NOT persist the key, so the copy must not
  // reuse the first-use "we'll save it" wording.
  const unverifiable = prompt.reason === "unverifiable";
  const titleKey = unverifiable ? "ssh.hostKey.unverifiable.title" : "ssh.hostKey.title";
  const bodyKey = unverifiable ? "ssh.hostKey.unverifiable.body" : "ssh.hostKey.body";
  const hintKey = unverifiable ? "ssh.hostKey.unverifiable.hint" : "ssh.hostKey.hint";

  return (
    <>
      <div
        aria-hidden="true"
        onClick={() => { void decide(false); }}
        className="overlay-backdrop"
        style={{
          position: "fixed",
          inset: 0,
          background: "var(--backdrop-color)",
          zIndex: 300,
        }}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ssh-host-key-title"
        aria-describedby="ssh-host-key-hop ssh-host-key-body ssh-host-key-hint"
        tabIndex={0}
        className="overlay-sheet"
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 440,
          maxWidth: "calc(100vw - 32px)",
          maxHeight: "calc(100vh - 32px)",
          minHeight: 0,
          background: "var(--c-bg-white)",
          borderRadius: "var(--r-overlay)",
          boxShadow: "var(--shadow-overlay)",
          zIndex: 301,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          outline: "none",
        }}
      >
        <div style={{ padding: "16px 18px", borderBottom: "1px solid var(--c-border-2)" }}>
          <span id="ssh-host-key-title" style={{ fontSize: "var(--fs-title)", fontWeight: 600, color: "var(--c-text-primary)" }}>
            {t(titleKey)}
          </span>
        </div>

        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12, overflowY: "auto", minHeight: 0, flex: 1 }}>
          <strong id="ssh-host-key-hop">{t(`ssh.hop.${prompt.hopRole}`)}</strong>
          <p id="ssh-host-key-body" style={{ margin: 0, fontSize: "var(--fs-body)", color: "var(--c-text-primary)", lineHeight: 1.5 }}>
            {t(bodyKey, { host: hostLabel })}
          </p>
          <div
            style={{
              padding: "10px 12px",
              borderRadius: "var(--r-btn)",
              background: "var(--c-bg-1)",
              border: "1px solid var(--c-border-2)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-meta)",
              color: "var(--c-text-primary)",
              wordBreak: "break-all",
            }}
          >
            <div style={{ color: "var(--c-text-4)", marginBottom: 4 }}>
              {prompt.keyType}
            </div>
            {prompt.fingerprint}
          </div>
          <p id="ssh-host-key-hint" style={{ margin: 0, fontSize: "var(--fs-meta)", color: "var(--c-text-4)", lineHeight: 1.5 }}>
            {t(hintKey)}
          </p>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "12px 18px",
            borderTop: "1px solid var(--c-border-2)",
          }}
        >
          <button
            ref={rejectRef}
            onClick={() => { void decide(false); }}
            disabled={submitting}
            className="ui-button"
            style={{
              padding: "6px 16px",
              fontSize: "var(--fs-body)",
            }}
          >
            {t("ssh.hostKey.reject")}
          </button>
          <button
            onClick={() => { void decide(true); }}
            disabled={submitting}
            className={unverifiable ? "ui-button" : "ui-button ui-button--primary"}
            style={{
              padding: "6px 18px",
              fontSize: "var(--fs-body)",
              fontWeight: 500,
              ...(unverifiable ? { color: "var(--c-warning-text)", borderColor: "var(--c-warning)" } : {}),
            }}
          >
            {t("ssh.hostKey.accept")}
          </button>
        </div>
      </div>
    </>
  );
}
