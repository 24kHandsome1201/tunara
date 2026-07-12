/**
 * Map a raw ssh_open error into a stable reason code. Pure logic — no i18n
 * dependency — so it can be unit-tested in Node without the Tauri/React
 * runtime. `pty-bridge.ts` maps these codes to localized strings via `t()`.
 *
 * The matching is intentionally substring-based on the lowercased error: russh
 * and the auth chain produce free-form English messages, and we only need a
 * coarse bucket for the user-facing toast.
 */
export type SshFailureReason = "auth" | "hostKey" | "connect" | "generic";

export function classifySshFailure(error: string): SshFailureReason {
  const e = error.toLowerCase();
  if (
    e.includes("mismatch") ||
    e.includes("host key") ||
    e.includes("host-key") ||
    e.includes("server key")
  ) {
    return "hostKey";
  }
  if (
    e.includes("connect") ||
    e.includes("refused") ||
    e.includes("timed out") ||
    e.includes("timeout")
  ) {
    return "connect";
  }
  if (
    e.includes("authentication failed") ||
    e.includes("unable to authenticate") ||
    e.includes("no authentication methods") ||
    e.includes("auth method") ||
    e.includes("permission denied (publickey")
  ) {
    return "auth";
  }
  return "generic";
}
