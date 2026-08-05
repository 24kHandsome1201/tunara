import { Channel, invoke } from "@tauri-apps/api/core";
import type { SessionBindingV1 } from "@/modules/terminal/lib/pty-bridge";

export const MANIFEST_LIMITS = { maxDepth: 32, maxEntries: 10_000, maxPathBytes: 4_096, maxTotalBytes: 10 * 1024 ** 3 } as const;
export interface ManifestLimits { maxDepth?: number; maxEntries?: number; maxPathBytes?: number; maxTotalBytes?: number }
export interface ManifestEntry { path: string; kind: "file" | "dir"; bytes: number }
export interface FolderManifest { files: ManifestEntry[]; totalBytes: number }
export type ManifestSource = { kind: "local"; root: string } | { kind: "remote"; root: string; binding: SessionBindingV1 };

/** Rust clamps every supplied value to MANIFEST_LIMITS; callers may only tighten limits. */
export function validateManifest(source: ManifestSource, limits?: ManifestLimits): Promise<FolderManifest> {
  return invoke<FolderManifest>("validate_manifest", { source, limits });
}

export interface SshUploadProgress {
  transferred: number;
  total: number;
}

/** Legacy transfer IPC adapter; command names and payloads are unchanged. */
export function sshDownload(id: number, remotePath: string, localPath: string): Promise<number> {
  return invoke<number>("ssh_fs_download", { id, remotePath, localPath });
}

export function sshUpload(
  id: number,
  transferId: string,
  localPath: string,
  remotePath: string,
  overwrite: boolean,
  onProgress: (progress: SshUploadProgress) => void,
): Promise<number> {
  const progress = new Channel<SshUploadProgress>();
  progress.onmessage = onProgress;
  return invoke<number>("ssh_fs_upload", {
    id, transferId, localPath, remotePath, overwrite, onProgress: progress,
  });
}

export function sshCancelUpload(transferId: string): Promise<boolean> {
  return invoke<boolean>("ssh_fs_cancel_upload", { transferId });
}

export type SshTransferPhase = "preparing" | "transferring" | "committing" | "terminal";
export interface SshTransferEvent {
  transferId: string;
  attempt: number;
  sequence: number;
  phase: SshTransferPhase;
  bytesTransferred: number;
  totalBytes: number | null;
}
export type SshTransferOutcome =
  | { status: "completed"; bytesTransferred: number }
  | { status: "cancelled"; bytesTransferred: number; residuePath: string | null }
  | {
    status: "failed" | "outcomeUnknown";
    bytesTransferred: number;
    code: "transferFailed" | "outcomeUnknown";
    message: string;
    residuePath: string | null;
  };
export type SshTransferCancelResult = "accepted" | "tooLate" | "notFound";

function transferChannel(onEvent: (event: SshTransferEvent) => void): Channel<SshTransferEvent> {
  const channel = new Channel<SshTransferEvent>();
  channel.onmessage = onEvent;
  return channel;
}

/** Ignore duplicate, stale, cross-transfer, and cross-attempt events. */
export function acceptSshTransferEvent(
  previous: SshTransferEvent | undefined,
  event: SshTransferEvent,
): SshTransferEvent | undefined {
  if (!previous) return event;
  if (previous.transferId !== event.transferId || previous.attempt !== event.attempt) return previous;
  return event.sequence > previous.sequence ? event : previous;
}

export function sshTransferDownload(
  binding: SessionBindingV1,
  transferId: string,
  attempt: number,
  remotePath: string,
  localPath: string,
  onEvent: (event: SshTransferEvent) => void,
): Promise<{ outcome: SshTransferOutcome }> {
  return invoke<{ outcome: SshTransferOutcome }>("ssh_transfer_download", {
    binding, transferId, attempt, remotePath, localPath, onEvent: transferChannel(onEvent),
  });
}

export function sshTransferUpload(
  binding: SessionBindingV1,
  transferId: string,
  attempt: number,
  localPath: string,
  remotePath: string,
  overwrite: boolean,
  onEvent: (event: SshTransferEvent) => void,
): Promise<{ outcome: SshTransferOutcome }> {
  return invoke<{ outcome: SshTransferOutcome }>("ssh_transfer_upload", {
    binding, transferId, attempt, localPath, remotePath, overwrite, onEvent: transferChannel(onEvent),
  });
}

export function sshTransferCancel(transferId: string, attempt: number): Promise<SshTransferCancelResult> {
  return invoke<SshTransferCancelResult>("ssh_transfer_cancel", { transferId, attempt });
}

export type TransferPartialIdentity =
  | { kind: "local"; path: string; size: number; dev: number | null; ino: number | null }
  | { kind: "remote"; path: string; endpoint: string; size: number; permissions: number | null };
export interface TransferJournalRecord {
  recoveryId: string;
  transferId: string;
  attempt: number;
  direction: string;
  session: string | null;
  endpoint: string;
  user: string;
  hostKey: string;
  source: string;
  sourceIdentity:
    | { kind: "local"; path: string; size: number; dev: number; ino: number }
    | { kind: "remote"; path: string; size: number; permissions: number | null }
    | { kind: "unverified" };
  finalPath: string;
  partial: TransferPartialIdentity;
  phase: string;
  bytes: number;
  prefixSha256: string;
  finalSha256: string | null;
  commitIntent: boolean;
  paused: boolean;
  needsReconcile: boolean;
}
export const sshTransferJournalLoad = () => invoke<TransferJournalRecord[]>("ssh_transfer_journal_load");
/** @deprecated Journal snapshots are read-only; Rust owns durable mutations. */
export const sshTransferJournalSave = (records: TransferJournalRecord[]) =>
  invoke<void>("ssh_transfer_journal_save", { records });
export const sshTransferJournalListOwnedPartials = () =>
  invoke<TransferJournalRecord[]>("ssh_transfer_journal_list_owned_partials");
export const sshTransferJournalCleanup = (recoveryId: string, identity: TransferPartialIdentity) =>
  invoke<boolean>("ssh_transfer_journal_cleanup", { recoveryId, identity });
export const sshTransferRecoveryPrepare = (binding: SessionBindingV1, recoveryId: string) =>
  invoke<{ record: TransferJournalRecord; observation: "partialMatches" | "finalMatches" | "finalAndPartialMatch" }>(
    "ssh_transfer_recovery_prepare", { binding, recoveryId },
  );
export const sshTransferRecoveryReconcile = (binding: SessionBindingV1, recoveryId: string) =>
  invoke<{ record: TransferJournalRecord; observation: "partialMatches" | "finalMatches" | "finalAndPartialMatch"; completed: boolean }>(
    "ssh_transfer_recovery_reconcile", { binding, recoveryId },
  );
export const sshTransferRecoveryDismiss = (recoveryId: string) =>
  invoke<void>("ssh_transfer_recovery_dismiss", { recoveryId });
