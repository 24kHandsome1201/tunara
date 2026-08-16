import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { fsReadDir } from "@/modules/fs/fs-bridge";
import {
  classifyTransferDrop,
  expandFolderTransfer,
  renamedSibling,
} from "@/modules/ssh/transfer-intent";
import { validateManifest } from "@/modules/ssh/transfer-bridge";
import { useTransferStore, type TransferRequest } from "@/modules/ssh/transfer-store";
import { sshStatV1, type MutationRequestV1 } from "@/modules/ssh/remote-fs/bridge";
import { performRemoteMutation } from "@/modules/ssh/remote-fs/actions";
import type { SessionBindingV1 } from "@/modules/terminal/lib/pty-bridge";
import { joinPath, nextOperationId } from "./helpers";

type Translate = (key: string, params?: Record<string, string | number>) => string;

export interface QueueLocalPathsOptions {
  binding: SessionBindingV1;
  remoteHost?: string;
  paths: string[];
  destinationRoot: string;
  t: Translate;
}

export type QueueLocalPathsResult =
  | { status: "queued"; files: number; directories: number }
  | { status: "prepareFailed" };

/**
 * Classify dropped/picked local paths into typed transfer requests, resolve
 * destination conflicts with the user (replace / rename / skip, batch or per
 * item), materialize target directories, and enqueue the resulting uploads.
 * Stat/dialog failures propagate to the caller; a failed directory
 * materialization is reported as `prepareFailed` so children never race a
 * missing parent.
 */
export async function queueLocalTransferPaths({
  binding,
  remoteHost,
  paths,
  destinationRoot,
  t,
}: QueueLocalPathsOptions): Promise<QueueLocalPathsResult> {
  const requests: TransferRequest[] = [];
  const directories: string[] = [];
  for (const localPath of paths) {
    let isDirectory = false;
    try {
      await fsReadDir(localPath, false);
      isDirectory = true;
    } catch {
      // Tauri exposes OS paths but not their kinds. Directory validation is
      // authoritative below; ordinary files continue through the file intent.
    }
    const intent = classifyTransferDrop({ localPaths: [localPath], folder: isDirectory });
    if (intent.kind === "folder") {
      const manifest = await validateManifest({ kind: "local", root: intent.root });
      const leaf = intent.root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "upload";
      const plan = expandFolderTransfer({
        manifest,
        binding,
        direction: "upload",
        sourceRoot: intent.root,
        destinationRoot: joinPath(destinationRoot, leaf),
        conflict: "rename",
      });
      directories.push(...plan.directories);
      requests.push(...plan.requests);
    } else if (intent.kind === "upload") {
      for (const source of intent.localPaths) {
        const leaf = source.split(/[\\/]/).pop() ?? "upload";
        requests.push({ binding, direction: "upload", source, destination: joinPath(destinationRoot, leaf), conflict: "rename" });
      }
    }
  }
  const conflicts: TransferRequest[] = [];
  for (const request of requests) {
    try {
      await sshStatV1(binding, request.destination);
      conflicts.push(request);
    } catch (error) {
      if (!String(error).includes("SSH_REMOTE_FS_NOT_FOUND")) throw error;
    }
  }
  if (conflicts.length > 0) {
    const endpoint = remoteHost ?? `${binding.logicalSessionId} / PTY ${binding.physicalPtyId}`;
    const replaceAll = await confirmDialog(t("transfer.preflight.message", {
      endpoint,
      root: destinationRoot,
      count: conflicts.length,
    }), { title: t("transfer.preflight.title"), kind: "warning" });
    if (replaceAll) {
      for (const conflict of conflicts) conflict.conflict = "replace";
    } else if (await confirmDialog(t("transfer.preflight.rename_all", { count: conflicts.length }), { title: t("transfer.preflight.title"), kind: "warning" })) {
      const occupied = new Set(requests.map((request) => request.destination));
      for (const conflict of conflicts) {
        let candidate = renamedSibling(conflict.destination, occupied);
        for (;;) {
          try { await sshStatV1(binding, candidate); occupied.add(candidate); candidate = renamedSibling(conflict.destination, occupied); }
          catch (error) { if (String(error).includes("SSH_REMOTE_FS_NOT_FOUND")) break; throw error; }
        }
        conflict.destination = candidate;
        conflict.conflict = "rename";
        occupied.add(conflict.destination);
      }
    } else if (await confirmDialog(t("transfer.preflight.skip_all", { count: conflicts.length }), { title: t("transfer.preflight.title"), kind: "warning" })) {
      for (const conflict of conflicts) requests.splice(requests.indexOf(conflict), 1);
    } else {
      const occupied = new Set(requests.map((request) => request.destination));
      for (const conflict of conflicts) {
        const replace = await confirmDialog(t("transfer.preflight.replace_item", { path: conflict.destination, endpoint }), { title: t("transfer.preflight.title"), kind: "warning" });
        if (replace) { conflict.conflict = "replace"; continue; }
        const rename = await confirmDialog(t("transfer.preflight.rename_item", { path: conflict.destination }), { title: t("transfer.preflight.title"), kind: "warning" });
        if (rename) {
          let candidate = renamedSibling(conflict.destination, occupied);
          for (;;) {
            try { await sshStatV1(binding, candidate); occupied.add(candidate); candidate = renamedSibling(conflict.destination, occupied); }
            catch (error) { if (String(error).includes("SSH_REMOTE_FS_NOT_FOUND")) break; throw error; }
          }
          conflict.destination = candidate;
          conflict.conflict = "rename";
          occupied.add(conflict.destination);
        } else requests.splice(requests.indexOf(conflict), 1);
      }
    }
  }
  // Folder uploads are a two-phase operation: materialize every directory
  // first (including empty ones), then publish file work to the queue. A
  // typed mutation failure aborts the whole plan so children never race a
  // missing parent and the UI never claims the folder was queued.
  try {
    for (const path of [...new Set(directories)]) {
      const parent = path.replace(/[\\/][^\\/]+$/, "") || "/";
      const parentMetadata = await sshStatV1(binding, parent);
      let existing;
      try {
        existing = await sshStatV1(binding, path);
      } catch (error) {
        if (!String(error).includes("SSH_REMOTE_FS_NOT_FOUND")) throw error;
        existing = undefined;
      }
      if (existing?.kind === "directory") continue;
      if (existing) throw new Error("folder destination already exists and is not a directory");
      const request: MutationRequestV1 = {
        operationId: nextOperationId(),
        binding,
        operation: { kind: "mkdir", path },
        precondition: { source: { state: "absent" }, sourceParent: parentMetadata.precondition },
      };
      const { result } = await performRemoteMutation(request);
      if (result.status !== "applied" && result.status !== "desiredStateObserved") {
        throw new Error("remote folder creation was not confirmed");
      }
    }
  } catch {
    return { status: "prepareFailed" };
  }
  if (requests.length > 0) useTransferStore.getState().enqueueBatch(requests);
  return { status: "queued", files: requests.length, directories: directories.length };
}
