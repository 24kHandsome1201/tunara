import { t } from "@/modules/i18n";
import { useUIStore } from "@/state/ui";
import type { RemoteInfo } from "@/ui/types";
import { makeHostId, saveHost, type SshHostProfile } from "./hosts-bridge";

/**
 * Snapshot of the host profile to persist after the SSH session reports
 * `connectionStatus` phase `"ready"` (see `send_connection_status(..., "ready")`
 * in `src-tauri/src/modules/ssh/connection.rs`). Built at Connect time so the
 * dialog can close before the backend handshake finishes; saved only on success.
 */
export function sshHostProfileFromSuccessfulConnect(
  remote: RemoteInfo,
  label: string,
  hosts: SshHostProfile[],
  selectedSaved?: SshHostProfile,
): SshHostProfile {
  const jumpId = remote.route?.profileId ?? "";
  const existing = selectedSaved ?? hosts.find((candidate) =>
    candidate.host === remote.host
    && candidate.port === remote.port
    && candidate.user === remote.user
    && (candidate.proxyJumpProfileId ?? "") === jumpId
  );
  const identity = remote.authMethod === "key" || remote.authMethod === "auto" ? remote.identityFile ?? "" : "";
  return {
    id: existing?.id ?? makeHostId(),
    label: existing?.label || label,
    host: remote.host,
    port: remote.port,
    user: remote.user,
    authMethod: remote.authMethod ?? "auto",
    identityFile: identity,
    certificateFile: remote.authMethod === "key" || remote.authMethod === "auto" ? remote.certificateFile ?? "" : "",
    ...(remote.route?.profileId ? { proxyJumpProfileId: remote.route.profileId } : {}),
  };
}

export async function persistSuccessfulSshHost(profile: SshHostProfile): Promise<void> {
  try {
    await saveHost(profile);
    useUIStore.getState().bumpSshProfilesEpoch();
  } catch {
    useUIStore.getState().addToast({ title: t("ssh.profile.save_failed"), subtitle: "", variant: "error" });
  }
}
