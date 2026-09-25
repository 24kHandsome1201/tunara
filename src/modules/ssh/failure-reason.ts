/**
 * Map a raw ssh_open_v2 error into a stable reason code. Pure logic — no i18n
 * dependency — so it can be unit-tested in Node without the Tauri/React
 * runtime. `pty-bridge.ts` maps these codes to localized strings via `t()`.
 *
 * The matching is intentionally substring-based on the lowercased error:
 * russh and the selected auth method produce free-form English messages, and
 * we only need a coarse bucket for the user-facing toast.
 */
import type { SshErrorCode } from "./diagnostics-schema.ts";

export type SshFailureReason =
  | "password"
  | "key"
  | "agent"
  | "keyboardInteractive"
  | "auto"
  | "auth"
  | "hostKey"
  | "connect"
  | "dns"
  | "refused"
  | "timeout"
  | "transport"
  | "invalidRequest"
  | "generic";

/** Typed backend codes keep their precision instead of collapsing into "connect". */
export function sshFailureReasonFromCode(code: SshErrorCode): SshFailureReason | null {
  switch (code) {
    case "authenticationFailed": return "auth";
    case "hostKeyRejected": return "hostKey";
    case "dnsFailed": return "dns";
    case "connectionRefused": return "refused";
    case "timeout": return "timeout";
    case "transportClosed": return "transport";
    case "invalidRequest": return "invalidRequest";
    default: return null;
  }
}

export function classifySshFailure(error: string): SshFailureReason {
  const e = error.toLowerCase();
  if (e.includes("automatic authentication")) return "auto";
  if (e.includes("password authentication")) return "password";
  if (e.includes("keyboard-interactive authentication")) return "keyboardInteractive";
  if (e.includes("key authentication")) return "key";
  if (e.includes("agent authentication")) return "agent";
  if (
    e.includes("mismatch") ||
    e.includes("host key") ||
    e.includes("host-key") ||
    e.includes("server key")
  ) {
    return "hostKey";
  }
  if (
    e.startsWith("resolve ") ||
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
