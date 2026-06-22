import type { PtySession } from "./pty-bridge";

export function schedulePendingInput({
  pty,
  input,
  submit,
  onConsumed,
}: {
  pty: PtySession;
  input: string | undefined;
  submit: boolean;
  onConsumed?: () => void;
}) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (input) {
    timer = setTimeout(() => {
      timer = null;
      pty.write(submit ? input + "\n" : input)
        .then(() => onConsumed?.())
        .catch(() => {});
    }, 300);
  }

  return {
    dispose() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
