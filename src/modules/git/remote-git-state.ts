import type { RemoteGitSnapshotV1 } from "./git-bridge.ts";

export type DerivedRemoteGitState = "repo" | "notGit" | "unknown";

/** Compatibility-only UI state; it is deliberately not part of the V1 wire. */
export function deriveRemoteGitState(snapshot: RemoteGitSnapshotV1): DerivedRemoteGitState {
  if (snapshot.repo) return "repo";
  if (snapshot.error?.kind === "notRepository") return "notGit";
  return "unknown";
}

export function forceForNonce(previousNonce: number, nonce: number): boolean {
  return nonce !== previousNonce;
}

export function snapshotMatches(
  snapshot: RemoteGitSnapshotV1,
  requestId: string,
  generation: number,
  binding: RemoteGitSnapshotV1["binding"],
): boolean {
  return snapshot.requestId === requestId && snapshot.generation === generation
    && snapshot.binding.logicalSessionId === binding.logicalSessionId
    && snapshot.binding.physicalPtyId === binding.physicalPtyId
    && snapshot.binding.transportGeneration === binding.transportGeneration;
}
