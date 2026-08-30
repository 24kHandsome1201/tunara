import { invoke } from "@tauri-apps/api/core";
import type { SessionBindingV1 } from "@/modules/terminal/lib/pty-bridge";

export type SshSystemSnapshotV1 =
  | {
      status: "available";
      observedAt: number;
      memoryTotalBytes: number;
      memoryAvailableBytes: number;
      rxBytes: number;
      txBytes: number;
      uptimeSeconds?: number;
    }
  | { status: "unsupported"; observedAt: number };

export function sshSystemSnapshotV1(binding: SessionBindingV1): Promise<SshSystemSnapshotV1> {
  return invoke<SshSystemSnapshotV1>("ssh_system_snapshot_v1", { binding });
}

export interface SshSystemRates {
  downloadBytesPerSecond: number;
  uploadBytesPerSecond: number;
}

/** Network counters are cumulative. A rate is valid only across increasing
 * observations without a counter reset (for example after a host reboot). */
export function calculateSshSystemRates(
  previous: SshSystemSnapshotV1 | undefined,
  current: SshSystemSnapshotV1,
): SshSystemRates | undefined {
  if (previous?.status !== "available" || current.status !== "available") return undefined;
  const elapsedSeconds = (current.observedAt - previous.observedAt) / 1000;
  if (elapsedSeconds <= 0 || current.rxBytes < previous.rxBytes || current.txBytes < previous.txBytes) {
    return undefined;
  }
  return {
    downloadBytesPerSecond: (current.rxBytes - previous.rxBytes) / elapsedSeconds,
    uploadBytesPerSecond: (current.txBytes - previous.txBytes) / elapsedSeconds,
  };
}
