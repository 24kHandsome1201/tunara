import { useEffect, useRef, useState } from "react";
import { useUIStore } from "@/state/ui";
import { useT } from "@/modules/i18n";
import { answerKeyboardInteractivePrompt } from "@/modules/terminal/lib/pty-bridge";
import { useFocusTrap } from "./useFocusTrap";

/** Server-driven keyboard-interactive authentication challenge. Secret values
 * live only in this component until the one-shot response invoke completes. */
export function KeyboardInteractivePromptDialog() {
  const t = useT();
  const prompt = useUIStore((s) => s.keyboardInteractivePrompts[0] ?? null);
  const dismiss = useUIStore((s) => s.dismissKeyboardInteractivePrompt);
  const dialogRef = useRef<HTMLDivElement>(null);
  const [responses, setResponses] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  useFocusTrap(dialogRef);

  useEffect(() => {
    setResponses(prompt?.prompts.map(() => "") ?? []);
    requestAnimationFrame(() => dialogRef.current?.querySelector<HTMLInputElement>("input")?.focus());
  }, [prompt?.promptId, prompt?.prompts]);

  if (!prompt) return null;

  const decide = async (next: string[] | null) => {
    if (submitting) return;
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

  return (
    <>
      <div
        onClick={() => { void decide(null); }}
        style={{ position: "fixed", inset: 0, background: "var(--backdrop-color)", zIndex: 320, animation: "fadeIn var(--duration-normal) var(--ease-smooth)" }}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ssh-keyboard-interactive-title"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "Escape") void decide(null);
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
            {prompt.name.trim() || t("ssh.keyboardInteractive.title")}
          </span>
          {prompt.instructions.trim() && (
            <span style={{ display: "block", marginTop: 5, fontSize: "var(--fs-secondary)", color: "var(--c-text-4)", lineHeight: 1.45, whiteSpace: "pre-wrap" }}>
              {prompt.instructions}
            </span>
          )}
        </div>

        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12, overflowY: "auto" }}>
          {prompt.prompts.map((item, index) => (
            <label key={`${prompt.promptId}:${index}`} style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: "var(--fs-secondary)", color: "var(--c-text-4)" }}>
              <span>{item.prompt || t("ssh.keyboardInteractive.response")}</span>
              <input
                type={item.echo ? "text" : "password"}
                value={responses[index] ?? ""}
                onChange={(event) => setResponses((current) => current.map((value, i) => i === index ? event.target.value : value))}
                autoComplete="off"
                spellCheck={false}
                style={{
                  width: "100%",
                  padding: "8px 10px",
                  borderRadius: "var(--r-btn)",
                  border: "1px solid var(--c-border-2)",
                  background: "var(--c-bg-input, var(--c-bg-white))",
                  color: "var(--c-text-primary)",
                  fontSize: "var(--fs-body)",
                  outline: "none",
                  boxSizing: "border-box",
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
            className="hover-bg"
            style={{ padding: "6px 16px", borderRadius: "var(--r-btn)", border: "1px solid var(--c-border-2)", background: "transparent", color: "var(--c-text-primary)", fontSize: "var(--fs-body)", cursor: submitting ? "wait" : "pointer" }}
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            onClick={() => { void decide(responses); }}
            disabled={submitting}
            className="hover-primary"
            style={{ padding: "6px 18px", borderRadius: "var(--r-btn)", border: "none", background: "var(--c-btn-primary-bg)", color: "var(--c-btn-primary-text)", fontSize: "var(--fs-body)", fontWeight: 500, cursor: submitting ? "wait" : "pointer", opacity: submitting ? 0.6 : 1 }}
          >
            {t("ssh.keyboardInteractive.continue")}
          </button>
        </div>
      </div>
    </>
  );
}
