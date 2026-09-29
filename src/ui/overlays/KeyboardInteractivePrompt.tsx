import { useEffect, useState } from "react";
import { useUIStore } from "@/state/ui";
import { useT } from "@/modules/i18n";
import { answerKeyboardInteractivePrompt } from "@/modules/terminal/lib/pty-bridge";
import {
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  MODAL_COLUMN_LAYOUT,
} from "./Modal";

/** Server-driven keyboard-interactive authentication challenge. Secret values
 * live only in this component until the one-shot response invoke completes. */
export function KeyboardInteractivePromptDialog() {
  const t = useT();
  const prompt = useUIStore((s) => s.keyboardInteractivePrompts[0] ?? null);
  const dismiss = useUIStore((s) => s.dismissKeyboardInteractivePrompt);
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

  if (!prompt) return null;

  return (
    <Modal
      labelledBy="ssh-keyboard-interactive-title"
      describedBy={prompt.instructions.trim() ? "ssh-keyboard-interactive-hop ssh-keyboard-interactive-instructions" : "ssh-keyboard-interactive-hop"}
      onRequestClose={() => { void decide(null); }}
      initialFocus="input"
      bindingKey={prompt.promptId}
      currentBindingKey={prompt.promptId}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) return;
        if (event.key === "Enter" && !(event.target instanceof HTMLButtonElement)) {
          event.preventDefault();
          void decide(responses);
        }
      }}
      style={{ ...MODAL_COLUMN_LAYOUT, width: 440, maxWidth: "calc(100vw - 32px)", maxHeight: "calc(100vh - 32px)" }}
    >
      <ModalHeader>
        <ModalTitle id="ssh-keyboard-interactive-title">{t("ssh.keyboardInteractive.title")}</ModalTitle>
        <strong id="ssh-keyboard-interactive-hop">{t(`ssh.hop.${prompt.hopRole}`)}</strong>
        <span style={{ display: "block", marginTop: 4, fontFamily: "var(--font-mono)", fontSize: "var(--fs-meta)", color: "var(--c-text-3)" }}>
          {prompt.origin.user}@{prompt.origin.host}:{prompt.origin.port}
        </span>
        {prompt.name.trim() && <span style={{ display: "block", marginTop: 5 }}>{prompt.name}</span>}
        {prompt.instructions.trim() && (
          <span id="ssh-keyboard-interactive-instructions" style={{ display: "block", marginTop: 5, fontSize: "var(--fs-secondary)", color: "var(--c-text-4)", lineHeight: 1.45, whiteSpace: "pre-wrap" }}>
            {prompt.instructions}
          </span>
        )}
      </ModalHeader>

      <ModalBody>
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
      </ModalBody>

      <ModalFooter>
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
      </ModalFooter>
    </Modal>
  );
}
