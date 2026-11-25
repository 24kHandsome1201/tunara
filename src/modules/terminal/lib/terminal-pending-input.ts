import type { PtySession } from "./pty-bridge";

export function schedulePendingInput({
  pty,
  input,
  submit,
  onWrite,
  onConsumed,
}: {
  pty: PtySession;
  input: string | undefined;
  submit: boolean;
  onWrite?: () => void;
  onConsumed?: () => void;
}) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (input) {
    timer = setTimeout(() => {
      timer = null;
      onWrite?.();
      // Match xterm's Enter key, including shells that bind Ctrl-J separately.
      pty.write(submit ? input + "\r" : input)
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
