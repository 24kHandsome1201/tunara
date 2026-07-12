export type FileOperationErrorKind = "permission" | "disconnected" | "unsupported" | "failed";

const includesAny = (value: string, fragments: readonly string[]) =>
  fragments.some((fragment) => value.includes(fragment));

/**
 * Convert backend and transport errors into a small, presentation-safe set.
 * Raw errors remain diagnostic details and are never rendered into the editor.
 */
export function classifyFileOperationError(error: unknown): FileOperationErrorKind {
  const message = String(error).toLocaleLowerCase();

  if (includesAny(message, ["permission denied", "operation not permitted", "access denied"])) {
    return "permission";
  }
  if (includesAny(message, [
    "no session",
    "not a remote session",
    "connection closed",
    "connection reset",
    "connection refused",
    "disconnected",
    "broken pipe",
    "timed out",
    "timeout",
    "channel closed",
    "unexpected eof",
  ])) {
    return "disconnected";
  }
  if (includesAny(message, [
    "must be a regular file",
    "must be utf-8",
    "editable content exceeds",
    "not supported",
    "unsupported",
  ])) {
    return "unsupported";
  }
  return "failed";
}
