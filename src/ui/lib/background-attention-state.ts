const seen = new Set<string>();

export function agentConfirmationAttentionKey(sessionId: string): string {
  return `agent-confirm:${sessionId}`;
}

/** Returns true the first time this key is seen. */
export function rememberBackgroundAttention(eventKey: string): boolean {
  if (!eventKey || seen.has(eventKey)) return false;
  seen.add(eventKey);
  return true;
}

export function forgetBackgroundAttention(eventKey: string): void {
  seen.delete(eventKey);
}

export function resetBackgroundAttention(): void {
  seen.clear();
}

export function peekBackgroundAttentionKeys(): readonly string[] {
  return [...seen];
}
