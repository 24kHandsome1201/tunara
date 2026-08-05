import {
  sshChmodV1,
  sshMutateV1,
  sshReconcileMutationV1,
  sshStatV1,
  type ChmodRequestV1,
  type ChmodResultV1,
  type MutationRequestV1,
  type MutationResultV1,
} from "./bridge";

export interface MutationActionResult {
  result: MutationResultV1;
  reconciled: boolean;
}

const PATH_TOCTOU = "SFTP v3 cannot bind lstat and pathname SETSTAT into one operation; refresh metadata before another attempt.";

export async function performRemoteChmod(request: ChmodRequestV1): Promise<ChmodResultV1> {
  try {
    return await sshChmodV1(request);
  } catch {
    // Tauri rejects both pre-mutation validation errors and lost responses, so
    // a generic rejection cannot prove execution was attempted. Observe only
    // for recovery context and never claim this chmod produced the state.
    const observed = await sshStatV1(request.binding, request.path);
    return {
      operationId: request.operationId,
      status: "outcomeUnknown",
      message: "the chmod command did not return a result; metadata was refreshed without retrying",
      observedMode: observed.mode,
      toctouBoundary: PATH_TOCTOU,
    };
  }
}

/**
 * Execute once. If the IPC response is unavailable, observe via the read-only
 * reconcile endpoint before the caller offers any retry. A second mutation is
 * never issued by this action.
 */
export async function performRemoteMutation(
  request: MutationRequestV1,
): Promise<MutationActionResult> {
  try {
    return { result: await sshMutateV1(request), reconciled: false };
  } catch {
    return { result: await sshReconcileMutationV1(request), reconciled: true };
  }
}
