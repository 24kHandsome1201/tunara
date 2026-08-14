import { useEffect, useRef, useState } from "react";
import { useUIStore } from "@/state/ui";
import { useT } from "@/modules/i18n";
import { answerKeyboardInteractivePrompt } from "@/modules/terminal/lib/pty-bridge";
import { useModalBehavior } from "./Modal";

/** Server-driven keyboard-interactive authentication challenge. Secret values
 * live only in this component until the one-shot response invoke completes. */
export function KeyboardInteractivePromptDialog() {
  const t = useT();
  const prompt = useUIStore((s) => s.keyboardInteractivePrompts[0] ?? null);
  const dismiss = useUIStore((s) => s.dismissKeyboardInteractivePrompt);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [responses, setResponses] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setResponses(prompt?.prompts.map(() => "") ?? []);
  }, [prompt?.promptId, prompt?.prompts]);

  const decide = async (next: string[] | null) => {
    if (!prompt || submitting) return;
    setSubmitting(true);
    try {
      await answerKeyboardInteractivePrompt(prompt.promptId, next);
      dismiss(prompt.promptId);
    } catch {
      // A timed-out/cancelled transport has no waiter left. Drop the stale
      // challenge rather than trapping the user in a dead modal.
      dismiss(prompt.promptId);
      useUIStore.getState().addToast({
        title: t("ssh.keyboardInteractive.response_failed"),
        subtitle: "",
        variant: "error",
      });
    } finally {
      setResponses([]);
      setSubmitting(false);
    }
  };

  useModalBehavior(dialogRef, {
    active: prompt !== null,
    initialFocus: "input",
    bindingKey: prompt?.promptId,
    currentBindingKey: prompt?.promptId,
    onRequestClose: () => { void decide(null); },
  });

  if (!prompt) return null;

  return (
    <>
      <div
        aria-hidden="true"
        onClick={() => { void decide(null); }}
        style={{ position: "fixed", inset: 0, background: "var(--backdrop-color)", zIndex: 320, animation: "fadeIn var(--duration-normal) var(--ease-smooth)" }}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ssh-keyboard-interactive-title"
        aria-describedby={prompt.instructions.trim() ? "ssh-keyboard-interactive-hop ssh-keyboard-interactive-instructions" : "ssh-keyboard-interactive-hop"}
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) {
            event.preventDefault();
            void decide(responses);
          }
        }}
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 440,
          maxWidth: "calc(100vw - 32px)",
          maxHeight: "calc(100vh - 32px)",
          background: "var(--c-bg-white)",
          borderRadius: "var(--r-overlay)",
          boxShadow: "var(--shadow-overlay)",
          zIndex: 321,
          animation: "sheetIn var(--duration-normal) var(--ease-out-back)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          outline: "none",
        }}
      >
        <div style={{ padding: "16px 18px", borderBottom: "1px solid var(--c-border-2)" }}>
          <span id="ssh-keyboard-interactive-title" style={{ display: "block", fontSize: "var(--fs-title)", fontWeight: 600, color: "var(--c-text-primary)" }}>
            {t("ssh.keyboardInteractive.title")}
          </span>
          <strong id="ssh-keyboard-interactive-hop">{t(`ssh.hop.${prompt.hopRole}`)}</strong>
          <span style={{ display: "block", marginTop: 4, fontFamily: "var(--font-mono)", fontSize: "var(--fs-meta)", color: "var(--c-text-3)" }}>
            {prompt.origin.user}@{prompt.origin.host}:{prompt.origin.port} · {t("ssh.keyboardInteractive.session", { session: prompt.origin.logicalSessionId })} · {t("ssh.keyboardInteractive.generation", { generation: prompt.origin.transportGeneration })}
          </span>
          {prompt.name.trim() && <span style={{ display: "block", marginTop: 5 }}>{prompt.name}</span>}
          {prompt.instructions.trim() && (
            <span id="ssh-keyboard-interactive-instructions" style={{ display: "block", marginTop: 5, fontSize: "var(--fs-secondary)", color: "var(--c-text-4)", lineHeight: 1.45, whiteSpace: "pre-wrap" }}>
              {prompt.instructions}
            </span>
          )}
        </div>

        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12, overflowY: "auto" }}>
          {prompt.prompts.map((item, index) => (
            <label key={`${prompt.promptId}:${index}`} style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: "var(--fs-secondary)", color: "var(--c-text-4)" }}>
              <span>{item.prompt || t("ssh.keyboardInteractive.response")}</span>
              <input
                className="ui-control"
                type={item.echo ? "text" : "password"}
                value={responses[index] ?? ""}
                onChange={(event) => setResponses((current) => current.map((value, i) => i === index ? event.target.value : value))}
                autoComplete="off"
                spellCheck={false}
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  fontSize: "var(--fs-body)",
                }}
              />
            </label>
          ))}
          <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-4)", lineHeight: 1.45 }}>
            {t("ssh.keyboardInteractive.hint")}
          </span>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "12px 18px", borderTop: "1px solid var(--c-border-2)" }}>
          <button
            type="button"
            onClick={() => { void decide(null); }}
            disabled={submitting}
            className="ui-button"
            style={{ padding: "6px 16px", fontSize: "var(--fs-body)" }}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            onClick={() => { void decide(responses); }}
            disabled={submitting}
            className="ui-button ui-button--primary"
            style={{ padding: "6px 18px", fontSize: "var(--fs-body)", fontWeight: 500 }}
          >
            {t("ssh.keyboardInteractive.continue")}
          </button>
        </div>
      </div>
    </>
  );
}
