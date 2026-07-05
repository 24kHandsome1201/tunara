import type { Terminal } from "@xterm/xterm";
import { t } from "@/modules/i18n";
import { useSessionsStore } from "@/state/sessions";

export function handleTerminalProcessExit(term: Terminal, sessionId: string, code: number): void {
  term.write(`\r\n\x1b[2m${t("terminal.inline.exited", { code })}\x1b[0m\r\n`);
  term.options.disableStdin = true;
  useSessionsStore.getState().handleTerminalExited(sessionId, code);
}
