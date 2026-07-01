import { useEffect, useRef } from "react";
import { useUIStore } from "@/state/ui";
import { useT } from "@/modules/i18n";
import { answerHostKeyPrompt } from "@/modules/terminal/lib/pty-bridge";
import { useFocusTrap } from "./useFocusTrap";

/**
 * App-level dialog shown when an SSH connection meets an unknown / unverifiable
 * host key (TOFU). The backend `ssh_open` call is blocked inside
 * `check_server_key` until the user accepts or rejects the fingerprint.
 */
export function HostKeyPromptDialog() {
  const t = useT();
  const prompt = useUIStore((s) => s.hostKeyPrompt);
  const setHostKeyPrompt = useUIStore((s) => s.setHostKeyPrompt);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef);

  const decide = (accept: boolean) => {
    if (!prompt) return;
    void answerHostKeyPrompt(prompt.promptId, accept);
    setHostKeyPrompt(null);
  };

  // Focus the safe (reject) action by default so an accidental Enter doesn't trust.
  const rejectRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (prompt) rejectRef.current?.focus();
  }, [prompt]);

  if (!prompt) return null;

  const hostLabel = prompt.port === 22 ? prompt.host : `${prompt.host}:${prompt.port}`;
  // "unverifiable" = host already in known_hosts but its key couldn't be
  // matched against the stored (hashed/wildcard) entry — a possible key
  // rotation or MITM, and this path deliberately does NOT persist the key. The
  // copy must say so rather than reuse the first-use "we'll save it" wording.
  const unverifiable = prompt.reason === "unverifiable";
  const titleKey = unverifiable ? "ssh.hostKey.unverifiable.title" : "ssh.hostKey.title";
  const bodyKey = unverifiable ? "ssh.hostKey.unverifiable.body" : "ssh.hostKey.body";
  const hintKey = unverifiable ? "ssh.hostKey.unverifiable.hint" : "ssh.hostKey.hint";

  return (
    <>
      <div
        onClick={() => decide(false)}
        style={{
          position: "fixed",
          inset: 0,
          background: "var(--backdrop-color)",
          backdropFilter: "var(--backdrop-blur)",
          zIndex: 300,
          animation: "fadeIn var(--duration-normal) var(--ease-smooth)",
        }}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        tabIndex={0}
        onKeyDown={(e: React.KeyboardEvent) => {
          if (e.key === "Escape") decide(false);
        }}
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 440,
          maxWidth: "calc(100vw - 32px)",
          background: "var(--c-bg-white)",
          borderRadius: "var(--r-overlay)",
          boxShadow: "var(--shadow-overlay)",
          zIndex: 301,
          animation: "sheetIn var(--duration-normal) var(--ease-out-back)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          outline: "none",
        }}
      >
        <div style={{ padding: "16px 18px", borderBottom: "1px solid var(--c-border-2)" }}>
          <span style={{ fontSize: "var(--fs-title)", fontWeight: 600, color: "var(--c-text-primary)" }}>
            {t(titleKey)}
          </span>
        </div>

        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
          <p style={{ margin: 0, fontSize: "var(--fs-body)", color: "var(--c-text-primary)", lineHeight: 1.5 }}>
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
          <p style={{ margin: 0, fontSize: "var(--fs-meta)", color: "var(--c-text-4)", lineHeight: 1.5 }}>
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
            onClick={() => decide(false)}
            className="hover-bg"
            style={{
              padding: "6px 16px",
              borderRadius: "var(--r-btn)",
              border: "1px solid var(--c-border-2)",
              background: "transparent",
              color: "var(--c-text-primary)",
              fontSize: "var(--fs-body)",
              cursor: "pointer",
            }}
          >
            {t("ssh.hostKey.reject")}
          </button>
          <button
            onClick={() => decide(true)}
            className="hover-primary"
            style={{
              padding: "6px 18px",
              borderRadius: "var(--r-btn)",
              border: "none",
              background: "var(--c-btn-primary-bg)",
              color: "var(--c-btn-primary-text)",
              fontSize: "var(--fs-body)",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            {t("ssh.hostKey.accept")}
          </button>
        </div>
      </div>
    </>
  );
}
