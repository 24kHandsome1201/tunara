import { useEffect, useRef, useState } from "react";
import { confirm as confirmDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import { sshCancelUpload, sshUpload } from "@/modules/ssh/remote-fs-bridge";
import { useUIStore } from "@/state/ui";
import { formatSize } from "@/ui/types";
import { joinPath } from "./helpers";
import { parseUploadFailure, uploadFailureKey } from "./transfer-failures";

type Translate = (key: string, params?: Record<string, string | number>) => string;

interface UploadTransfer {
  transferId?: string;
  cancelled: boolean;
  disposed?: boolean;
  backendActive?: boolean;
  cancelRequest?: Promise<boolean>;
  lastAnnouncementAt?: number;
  lastAnnouncementPercent?: number;
}

function requestUploadCancellation(transfer: UploadTransfer): Promise<boolean> {
  if (transfer.cancelRequest) return transfer.cancelRequest;
  transfer.cancelRequest = (async () => {
    while (transfer.backendActive && transfer.transferId) {
      if (await sshCancelUpload(transfer.transferId)) return true;
      // The invoke can reach the frontend before Rust has registered the ID.
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  })();
  return transfer.cancelRequest;
}

export interface UploadProgress {
  transferId: string;
  fileName: string;
  transferred: number;
  total: number;
  cancelling: boolean;
}

export interface DirectUploadOptions {
  sessionId: string;
  remotePtyId: number | undefined;
  t: Translate;
  onUploaded: () => void;
}

export interface DirectUpload {
  upload: UploadProgress | null;
  transferAnnouncement: string;
  isUploadActive: () => boolean;
  uploadFilesDirect: (directory: string) => Promise<void>;
  cancelUpload: () => void;
}

/**
 * Legacy per-file SFTP upload path for remote sessions without a typed
 * transfer binding: pick files, upload sequentially with progress state and
 * throttled a11y announcements, confirm overwrites, and support cooperative
 * cancellation that also covers the window before Rust registers the ID.
 */
export function useDirectUpload({ sessionId, remotePtyId, t, onUploaded }: DirectUploadOptions): DirectUpload {
  const [upload, setUpload] = useState<UploadProgress | null>(null);
  const uploadTransferRef = useRef<UploadTransfer | null>(null);
  const [transferAnnouncement, setTransferAnnouncement] = useState("");

  useEffect(() => () => {
    const transfer = uploadTransferRef.current;
    if (!transfer) return;
    transfer.cancelled = true;
    transfer.disposed = true;
    if (uploadTransferRef.current === transfer) uploadTransferRef.current = null;
    if (transfer.transferId) {
      setUpload((current) => current?.transferId === transfer.transferId ? null : current);
    }
    setTransferAnnouncement("");
    if (transfer.transferId) void requestUploadCancellation(transfer).catch(() => {});
  }, [remotePtyId, sessionId]);

  const isUploadActive = () => uploadTransferRef.current !== null;

  const uploadFilesDirect = async (directory: string) => {
    if (remotePtyId === undefined || uploadTransferRef.current) return;
    const transfer: UploadTransfer = { cancelled: false };
    uploadTransferRef.current = transfer;
    let selected: string | string[] | null;
    try {
      selected = await openDialog({
        title: t("explorer.upload.choose_file"),
        directory: false,
        multiple: true,
      });
    } catch {
      if (!transfer.disposed) {
        useUIStore.getState().addToast({ sessionId, title: t("explorer.upload.failed"), subtitle: t("explorer.upload.failed_hint"), variant: "error" });
      }
      if (uploadTransferRef.current === transfer) uploadTransferRef.current = null;
      return;
    }
    const localPaths = selected === null ? [] : Array.isArray(selected) ? selected : [selected];
    if (localPaths.length === 0 || transfer.cancelled) {
      if (uploadTransferRef.current === transfer) uploadTransferRef.current = null;
      return;
    }
    try {
      for (const localPath of localPaths) {
        if (transfer.cancelled) break;
        const fileName = localPath.split(/[\\/]/).filter(Boolean).pop();
        if (!fileName) continue;
        const remotePath = joinPath(directory, fileName);
        const transferId = globalThis.crypto?.randomUUID?.() ?? `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        transfer.transferId = transferId;
        transfer.lastAnnouncementAt = Date.now();
        transfer.lastAnnouncementPercent = 0;
        setUpload({ transferId, fileName, transferred: 0, total: 0, cancelling: false });
        setTransferAnnouncement(t("explorer.upload.announcement", { file: fileName, percent: 0 }));

        const throwIfCancelled = () => {
          if (transfer.cancelled) throw new Error("upload cancelled");
        };

        const run = async (overwrite: boolean) => {
          throwIfCancelled();
          transfer.backendActive = true;
          try {
            return await sshUpload(
              remotePtyId,
              transferId,
              localPath,
              remotePath,
              overwrite,
              ({ transferred, total }) => {
                if (!transfer.disposed) {
                  setUpload((current) => current?.transferId === transferId
                    ? { ...current, transferred, total }
                    : current);
                  const percent = total > 0 ? Math.min(100, Math.floor(transferred / total * 100)) : 0;
                  const percentBucket = Math.floor(percent / 10) * 10;
                  const now = Date.now();
                  const crossedTenPercent = percentBucket >= (transfer.lastAnnouncementPercent ?? 0) + 10;
                  const waitedTwoSeconds = now - (transfer.lastAnnouncementAt ?? now) >= 2_000;
                  if (crossedTenPercent || waitedTwoSeconds) {
                    transfer.lastAnnouncementAt = now;
                    transfer.lastAnnouncementPercent = percentBucket;
                    setTransferAnnouncement(t("explorer.upload.announcement", { file: fileName, percent }));
                  }
                }
              },
            );
          } finally {
            transfer.backendActive = false;
          }
        };

        try {
          let bytes: number;
          try {
            bytes = await run(false);
          } catch (error) {
            if (!String(error).includes("SSH_TRANSFER_DESTINATION_EXISTS")) throw error;
            throwIfCancelled();
            const overwrite = await confirmDialog(t("explorer.upload.overwrite_message", { file: fileName }), {
              title: t("explorer.upload.overwrite_title"),
              kind: "warning",
            });
            if (!overwrite) continue;
            throwIfCancelled();
            bytes = await run(true);
          }
          if (!transfer.disposed) {
            setTransferAnnouncement("");
            useUIStore.getState().addToast({
              sessionId,
              title: t("explorer.upload.complete"),
              subtitle: `${fileName} · ${formatSize(bytes)}`,
              variant: "success",
              action: {
                kind: "open-remote-preview",
                sessionId,
                path: remotePath,
                label: t("explorer.upload.preview"),
              },
            });
            onUploaded();
          }
        } catch (error) {
          const failure = parseUploadFailure(error);
          if (!transfer.disposed && (failure.kind !== "cancelled" || failure.residuePath)) {
            setTransferAnnouncement("");
            const primary = t(uploadFailureKey(error));
            const residue = failure.residuePath
              ? ` ${t("explorer.upload.error_residue", { path: failure.residuePath })}`
              : "";
            useUIStore.getState().addToast({
              sessionId,
              title: t("explorer.upload.failed"),
              subtitle: `${primary}${residue}`,
              variant: "error",
            });
          }
        } finally {
          setUpload((current) => current?.transferId === transferId ? null : current);
        }
      }
    } finally {
      if (uploadTransferRef.current === transfer) uploadTransferRef.current = null;
      transfer.transferId = undefined;
      setTransferAnnouncement("");
    }
  };

  const cancelUpload = () => {
    const transfer = uploadTransferRef.current;
    if (!transfer) return;
    transfer.cancelled = true;
    setTransferAnnouncement(t("explorer.upload.cancelling"));
    setUpload((current) => current ? { ...current, cancelling: true } : null);
    if (transfer.transferId && transfer.backendActive) {
      void requestUploadCancellation(transfer).catch(() => {});
    }
  };

  return { upload, transferAnnouncement, isUploadActive, uploadFilesDirect, cancelUpload };
}
