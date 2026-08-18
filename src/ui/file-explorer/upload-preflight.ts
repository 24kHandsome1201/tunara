import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import {
  sshUploadMaterializationReconcileV1,
  sshUploadMaterializeV1,
  sshUploadPreflightV1,
  type UploadActionV1,
  type UploadDecisionV1,
  type UploadPlanItemV1,
  type UploadPlanV1,
} from "@/modules/ssh/transfer-bridge";
import { useTransferStore, type TransferRequest } from "@/modules/ssh/transfer-store";
import type { SessionBindingV1 } from "@/modules/terminal/lib/pty-bridge";
import { nextOperationId } from "./helpers";

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
  | { status: "prepareFailed"; outcomeUnknown?: boolean };

/** Descendant conflicts are governed by their conflicting directory ancestor. */
export function actionableUploadConflicts(plan: UploadPlanV1): UploadPlanItemV1[] {
  const conflictingDirectories: string[] = [];
  return plan.items.filter((item) => {
    if (conflictingDirectories.some((parent) => item.relativePath.startsWith(`${parent}/`))) return false;
    const conflict = item.destination === "fileConflict" || item.destination === "blockingNonDirectory";
    if (conflict && item.kind === "dir") conflictingDirectories.push(item.relativePath);
    return conflict;
  });
}

async function collectUploadDecisions(
  plan: UploadPlanV1,
  remoteHost: string | undefined,
  destinationRoot: string,
  t: Translate,
): Promise<UploadDecisionV1[]> {
  const conflicts = actionableUploadConflicts(plan);
  if (conflicts.length === 0) return [];
  const endpoint = remoteHost ?? `${plan.binding.logicalSessionId} / PTY ${plan.binding.physicalPtyId}`;
  const replaceAll = await confirmDialog(t("transfer.preflight.message", {
    endpoint,
    root: destinationRoot,
    count: conflicts.length,
  }), { title: t("transfer.preflight.title"), kind: "warning" });
  if (replaceAll) {
    // A directory/symlink blocker is never deleted. "Replace all" safely
    // allocates it a fresh sibling while regular files retain replace semantics.
    return conflicts.map((item) => ({
      itemId: item.itemId,
      action: item.destination === "fileConflict" ? "replace" : "rename",
    }));
  }
  if (await confirmDialog(t("transfer.preflight.rename_all", { count: conflicts.length }), { title: t("transfer.preflight.title"), kind: "warning" })) {
    return conflicts.map((item) => ({ itemId: item.itemId, action: "rename" }));
  }
  if (await confirmDialog(t("transfer.preflight.skip_all", { count: conflicts.length }), { title: t("transfer.preflight.title"), kind: "warning" })) {
    return conflicts.map((item) => ({ itemId: item.itemId, action: "skip" }));
  }

  const decisions: UploadDecisionV1[] = [];
  for (const item of conflicts) {
    let action: UploadActionV1 = "skip";
    if (item.destination === "fileConflict" && await confirmDialog(t("transfer.preflight.replace_item", {
      path: item.proposedDestination,
      endpoint,
    }), { title: t("transfer.preflight.title"), kind: "warning" })) {
      action = "replace";
    } else if (await confirmDialog(t("transfer.preflight.rename_item", { path: item.proposedDestination }), {
      title: t("transfer.preflight.title"),
      kind: "warning",
    })) {
      action = "rename";
    }
    decisions.push({ itemId: item.itemId, action });
  }
  return decisions;
}

/**
 * The backend owns source enumeration, destination observations, destination
 * paths, and directory mutations. The UI submits only opaque item decisions
 * and publishes one batch after materialization is fully confirmed.
 */
export async function queueLocalTransferPaths({
  binding,
  remoteHost,
  paths,
  destinationRoot,
  t,
}: QueueLocalPathsOptions): Promise<QueueLocalPathsResult> {
  const operationId = nextOperationId();
  const plan = await sshUploadPreflightV1({
    operationId,
    binding,
    localSources: paths,
    destinationRoot,
  });
  const decisions = await collectUploadDecisions(plan, remoteHost, destinationRoot, t);
  let materialized;
  try {
    materialized = await sshUploadMaterializeV1(plan.planId, operationId, decisions);
  } catch {
    // The materialize response may have been lost after a mkdir reached the
    // server. Retrying the mutation is forbidden; only observe the same token.
    try {
      materialized = await sshUploadMaterializationReconcileV1(plan.planId, operationId);
    } catch {
      return { status: "prepareFailed", outcomeUnknown: true };
    }
  }
  if (materialized.status === "outcomeUnknown") {
    try {
      materialized = await sshUploadMaterializationReconcileV1(plan.planId, operationId);
    } catch {
      return { status: "prepareFailed", outcomeUnknown: true };
    }
  }
  if (materialized.status !== "ready") {
    return { status: "prepareFailed", outcomeUnknown: materialized.status === "outcomeUnknown" };
  }
  const requests: TransferRequest[] = materialized.descriptors.map((descriptor) => ({
    binding: plan.binding,
    direction: "upload",
    source: descriptor.sourcePath,
    destination: descriptor.destinationPath,
    conflict: descriptor.overwrite ? "replace" : "rename",
  }));
  if (requests.length > 0) useTransferStore.getState().enqueueBatch(requests);
  const itemStatus = new Map(materialized.items.map((item) => [item.itemId, item.status]));
  const directories = plan.items.filter((item) => item.kind === "dir" && itemStatus.get(item.itemId) !== "skipped").length;
  return { status: "queued", files: requests.length, directories };
}
