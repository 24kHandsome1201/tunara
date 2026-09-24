import type { Terminal } from "@xterm/xterm";
import { t } from "@/modules/i18n";
import { useSessionsStore } from "@/state/sessions";
import { SSH_DISCONNECTED_EXIT_CODE } from "@/modules/terminal/lib/pty-bridge";

/**
 * Marks the session exited and prints the inline exit notice. The exit event
 * arrives on the same ordered channel after the final output, but that output
 * may still be queued in the frame-batched output buffer; `pendingOutput`
 * resolves once it has reached xterm so the notice lands below the shell's
 * last echo (e.g. `exit`) instead of above it. Resolves after the notice is
 * parsed, or without writing when `isDisposed` reports teardown.
 */
export function handleTerminalProcessExit(
  term: Terminal,
  sessionId: string,
  code: number,
  remote = false,
  pendingOutput: Promise<void> = Promise.resolve(),
  isDisposed: () => boolean = () => false,
): Promise<void> {
  const message = remote && code === SSH_DISCONNECTED_EXIT_CODE
    ? t("terminal.inline.disconnected")
    : t("terminal.inline.exited", { code });
  term.options.disableStdin = true;
  useSessionsStore.getState().handleTerminalExited(sessionId, code);
  return pendingOutput.then(() => new Promise<void>((resolve) => {
    if (isDisposed()) {
      resolve();
      return;
    }
    term.write(`\r\n\x1b[2m${message}\x1b[0m\r\n`, resolve);
  }));
}
