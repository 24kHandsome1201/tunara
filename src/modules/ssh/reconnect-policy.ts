export const SSH_RECONNECT_MAX_ATTEMPTS = 4;
export const SSH_RECONNECT_BASE_DELAY_MS = 500;
export const SSH_RECONNECT_MAX_DELAY_MS = 8_000;

/** Full-jitter delay: uniformly distributed below the capped exponential bound. */
export function sshReconnectDelayMs(attempt: number, random = Math.random): number {
  const exponent = Math.max(0, Math.min(attempt - 1, 30));
  const cap = Math.min(SSH_RECONNECT_MAX_DELAY_MS, SSH_RECONNECT_BASE_DELAY_MS * (2 ** exponent));
  return Math.floor(Math.max(0, Math.min(0.999999999, random())) * cap);
}

export function canRetrySshReconnect(attempt: number): boolean {
  return attempt < SSH_RECONNECT_MAX_ATTEMPTS;
}
