import type { SessionBindingV1 } from "@/modules/terminal/lib/pty-bridge";
import type { FolderManifest } from "./transfer-bridge";
import type { TransferConflict, TransferDirection, TransferRequest } from "./transfer-store";

export type DragDropIntent =
  | { kind: "upload"; localPaths: string[] }
  | { kind: "download"; remotePaths: string[] }
  | { kind: "folder"; direction: TransferDirection; root: string };

export function classifyTransferDrop(input: { localPaths?: string[]; remotePaths?: string[]; folder?: boolean }): DragDropIntent {
  if (input.localPaths?.length && !input.remotePaths?.length)
    return input.folder ? { kind: "folder", direction: "upload", root: input.localPaths[0] } : { kind: "upload", localPaths: input.localPaths };
  if (input.remotePaths?.length && !input.localPaths?.length)
    return input.folder ? { kind: "folder", direction: "download", root: input.remotePaths[0] } : { kind: "download", remotePaths: input.remotePaths };
  throw new Error("drop must contain exactly one local or remote source kind");
}

const utf8 = new TextEncoder();
const join = (root: string, relative: string) => `${root.replace(/[\\/]$/, "")}/${relative}`;

/** Generate a distinct sibling, shortening the stem until the UTF-8 bound fits. */
export function renamedSibling(path: string, occupied: ReadonlySet<string>, maxBytes = 4_096): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const parent = path.slice(0, slash + 1); const leaf = path.slice(slash + 1);
  const dot = leaf.lastIndexOf("."); const extension = dot > 0 ? leaf.slice(dot) : ""; const stem = dot > 0 ? leaf.slice(0, dot) : leaf;
  for (let index = 1; index <= 10_000; index++) {
    const suffix = ` (${index})${extension}`;
    let candidateStem = stem;
    while (candidateStem && utf8.encode(parent + candidateStem + suffix).length > maxBytes) candidateStem = candidateStem.slice(0, -1);
    const candidate = parent + candidateStem + suffix;
    if (utf8.encode(candidate).length <= maxBytes && !occupied.has(candidate)) return candidate;
  }
  throw new Error("could not generate a bounded sibling name");
}

export interface FolderTransferPlan { directories: string[]; requests: TransferRequest[] }
export type ConflictDecision = { conflict: TransferConflict; applyAll?: boolean };

/** Apply an ask-dialog's decisions without ever upgrading an undecided item to replace. */
export function resolveTransferConflicts<T extends { destination: string }>(
  items: readonly T[], conflicts: ReadonlySet<string>, decisions: readonly ConflictDecision[],
): (T & { conflict: TransferConflict })[] {
  let applyAll: TransferConflict | undefined;
  let cursor = 0;
  return items.flatMap((item) => {
    if (!conflicts.has(item.destination)) return [{ ...item, conflict: "rename" as const }];
    const selected = applyAll ? undefined : decisions[cursor++];
    const decision = applyAll ?? selected?.conflict ?? "skip";
    if (selected?.applyAll) applyAll = decision;
    return decision === "skip" ? [] : [{ ...item, conflict: decision }];
  });
}
export function expandFolderTransfer(options: {
  manifest: FolderManifest; binding: SessionBindingV1; direction: TransferDirection;
  sourceRoot: string; destinationRoot: string; conflict: TransferConflict; occupied?: ReadonlySet<string>;
}): FolderTransferPlan {
  const { manifest, binding, direction, sourceRoot, destinationRoot, conflict } = options;
  const occupied = new Set(options.occupied ?? []);
  // Root and parents must exist before any child request. Keeping directories
  // depth ordered also makes empty directories real rather than incidental.
  const directories: string[] = [destinationRoot.replace(/[\\/]$/, "")];
  const requests: TransferRequest[] = [];
  for (const entry of manifest.files) {
    const source = join(sourceRoot, entry.path);
    let destination = join(destinationRoot, entry.path);
    if (entry.kind === "dir") { directories.push(destination); continue; }
    let itemConflict = conflict;
    if (occupied.has(destination)) {
      if (conflict === "skip") continue;
      if (conflict === "rename") { destination = renamedSibling(destination, occupied); itemConflict = "rename"; }
    }
    occupied.add(destination);
    requests.push({ binding, direction, source, destination, conflict: itemConflict });
  }
  directories.sort((a, b) => a.split(/[\\/]/).length - b.split(/[\\/]/).length || a.localeCompare(b));
  return { directories: [...new Set(directories)], requests };
}
