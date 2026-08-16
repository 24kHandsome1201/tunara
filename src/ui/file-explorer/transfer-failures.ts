export function downloadFailureKey(error: unknown): string {
  const message = String(error).toLowerCase();
  if (message.includes("destination already exists")) return "explorer.download.error_exists";
  if (message.includes("exceeds download limit")) return "explorer.download.error_limit";
  if (message.includes("under the home directory") || message.includes("refusing to write") || message.includes("download path")) {
    return "explorer.download.error_unsafe_path";
  }
  if (message.includes("write local file") || message.includes("permission") || message.includes("space")) {
    return "explorer.download.error_local_write";
  }
  if (message.includes("connection") || message.includes("transport") || message.includes("session") || message.includes("timed out") || message.includes("timeout") || message.includes("pty")) {
    return "explorer.download.error_connection";
  }
  return "explorer.download.failed_hint";
}

export interface UploadFailure {
  kind: string;
  residuePath?: string;
}

export function parseUploadFailure(error: unknown): UploadFailure {
  const raw = String(error);
  if (raw.includes("SSH_TRANSFER_CANCELLED")) return { kind: "cancelled" };
  if (raw.includes("SSH_TRANSFER_UNSUPPORTED")) return { kind: "unsupported" };
  if (raw.includes("SSH_TRANSFER_CHANGED")) return { kind: "changed" };
  if (raw.includes("SSH_TRANSFER_OUTCOME_UNKNOWN")) return { kind: "uncertain" };
  if (raw.includes("SSH_TRANSFER_PARTIAL")) return { kind: "partial" };
  const prefix = "tunaraUploadError:";
  const offset = raw.indexOf(prefix);
  if (offset >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(offset + prefix.length)) as unknown;
      if (parsed && typeof parsed === "object" && "kind" in parsed && typeof parsed.kind === "string") {
        return {
          kind: parsed.kind,
          residuePath: "residuePath" in parsed && typeof parsed.residuePath === "string"
            ? parsed.residuePath
            : undefined,
        };
      }
    } catch {
      // Fall through to compatibility matching for malformed/older errors.
    }
  }
  const message = raw.toLowerCase();
  if (message.includes("upload cancelled")) return { kind: "cancelled" };
  if (message.includes("does not support safe atomic overwrite")) return { kind: "unsupported" };
  if (message.includes("permissions changed during upload")) return { kind: "changed" };
  if (message.includes("outcome unknown after replacement")) return { kind: "uncertain" };
  if (message.includes("partial upload may remain")) return { kind: "partial" };
  return { kind: "generic" };
}

export function uploadFailureKey(error: unknown): string {
  const { kind } = parseUploadFailure(error);
  if (kind === "unsupported") return "explorer.upload.error_unsupported_overwrite";
  if (kind === "changed") return "explorer.upload.error_changed";
  if (kind === "uncertain") return "explorer.upload.error_uncertain";
  if (kind === "partial") return "explorer.upload.error_partial";
  if (kind === "cancelled") return "explorer.upload.error_cancelled";
  return "explorer.upload.failed_hint";
}
