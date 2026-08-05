import { invoke } from "@tauri-apps/api/core";
import type { SessionBindingV1 } from "@/modules/terminal/lib/pty-bridge";

export type RemotePathKindV1 = "file" | "directory" | "symlink" | "other";

export interface PathIdentityV1 {
  kind: RemotePathKindV1;
  size?: number;
  mode?: number;
  modifiedAt?: number;
}

export type PathExpectationV1 =
  | { state: "absent" }
  | { state: "present"; identity: PathIdentityV1 };

export interface MutationPreconditionV1 {
  source: PathExpectationV1;
  sourceParent: PathIdentityV1;
  destination?: PathExpectationV1;
  destinationParent?: PathIdentityV1;
}

export type MutationOperationV1 =
  | { kind: "mkdir"; path: string }
  | {
      kind: "rename";
      sourcePath: string;
      destinationPath: string;
      replace: boolean;
    }
  | { kind: "delete"; path: string };

export interface MutationRequestV1 {
  operationId: string;
  binding: SessionBindingV1;
  operation: MutationOperationV1;
  precondition: MutationPreconditionV1;
}

export type MutationStatusV1 =
  | "applied"
  | "desiredStateObserved"
  | "conflict"
  | "notFound"
  | "unsupported"
  | "outcomeUnknown";

export interface MutationResultV1 {
  operationId: string;
  status: MutationStatusV1;
  message: string;
  atomic: boolean;
}

export type CapabilityStateV1 = "supported" | "unsupported" | "unknown";

export interface RemoteMetadataV1 {
  path: string;
  kind: RemotePathKindV1;
  precondition: PathIdentityV1;
  parentPrecondition?: PathIdentityV1;
  size?: number;
  mode?: number;
  uid?: number;
  gid?: number;
  user?: string;
  group?: string;
  accessedAt?: number;
  modifiedAt?: number;
  linkTarget?: string;
  capability: {
    chmod: CapabilityStateV1;
    handleSetstat: CapabilityStateV1;
    posixRename: CapabilityStateV1;
  };
}

export interface ChmodRequestV1 {
  operationId: string;
  binding: SessionBindingV1;
  path: string;
  mode: number;
  expected: PathIdentityV1;
  expectedParent: PathIdentityV1;
}

export interface ChmodResultV1 {
  operationId: string;
  status: MutationStatusV1;
  message: string;
  observedMode?: number;
  mechanism?: "handleFsetstat" | "pathSetstat";
  toctouBoundary: string;
}

export function sshMutateV1(request: MutationRequestV1): Promise<MutationResultV1> {
  return invoke<MutationResultV1>("ssh_fs_mutate_v1", { request });
}

/** Read-only observation after an IPC response was lost. Never retries. */
export function sshReconcileMutationV1(request: MutationRequestV1): Promise<MutationResultV1> {
  return invoke<MutationResultV1>("ssh_fs_reconcile_mutation_v1", { request });
}

/** Metadata is always obtained with LSTAT. Symlink targets are read separately. */
export function sshStatV1(binding: SessionBindingV1, path: string): Promise<RemoteMetadataV1> {
  return invoke<RemoteMetadataV1>("ssh_fs_stat_v1", { binding, path });
}

export function sshChmodV1(request: ChmodRequestV1): Promise<ChmodResultV1> {
  return invoke<ChmodResultV1>("ssh_fs_chmod_v1", { request });
}
