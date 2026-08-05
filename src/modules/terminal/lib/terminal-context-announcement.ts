export const TERMINAL_CONTEXT_ANNOUNCEMENT_EVENT = "tunara:terminal-context-announcement";

export interface TerminalContextAnnouncement {
  reason: string;
  logicalSessionId: string;
  title?: string;
  index?: number;
  total?: number;
}

export function announceTerminalContext(detail: TerminalContextAnnouncement): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<TerminalContextAnnouncement>(TERMINAL_CONTEXT_ANNOUNCEMENT_EVENT, { detail }));
}
