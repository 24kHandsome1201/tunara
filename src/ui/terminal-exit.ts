import type { Terminal } from "@xterm/xterm";
import { t } from "@/modules/i18n";
import { useSessionsStore } from "@/state/sessions";
import { SSH_DISCONNECTED_EXIT_CODE } from "@/modules/terminal/lib/pty-bridge";

export function handleTerminalProcessExit(term: Terminal, sessionId: string, code: number, remote = false): void {
  const message = remote && code === SSH_DISCONNECTED_EXIT_CODE
    ? t("terminal.inline.disconnected")
    : t("terminal.inline.exited", { code });
  term.write(`\r\n\x1b[2m${message}\x1b[0m\r\n`);
  term.options.disableStdin = true;
  useSessionsStore.getState().handleTerminalExited(sessionId, code);
}
