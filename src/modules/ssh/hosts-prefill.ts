import type { SshHostProfile, SshProfileEntryV1, SshProfilesPanelModelV1 } from "./hosts-model.ts";
import { resolveSshProfileRoute } from "./hosts-model.ts";

export function sshConnectPrefillFromProfile(
  profile: SshHostProfile,
  panel: SshProfilesPanelModelV1,
  source: "saved" | "sshConfig" = "saved",
) {
  const resolution = resolveSshProfileRoute(profile.id, source, panel);
  const target = resolution.status === "ready" ? resolution.route.target : profile;
  const jump = resolution.status === "ready" ? resolution.route.jump : undefined;
  return {
    host: target.host,
    port: target.port,
    user: target.user,
    authMethod: target.authMethod,
    identityFile: target.identityFile || undefined,
    certificateFile: target.certificateFile,
    ...(profile.autoReconnect ? { autoReconnect: true } : {}),
    ...(profile.injectShellIntegration === false ? { injectShellIntegration: false } : {}),
    ...(jump
      ? {
          route: {
            profileId: profile.id,
            jump: {
              host: jump.host,
              port: jump.port,
              user: jump.user,
              authMethod: jump.authMethod,
              identityFile: jump.identityFile || undefined,
              certificateFile: jump.certificateFile,
            },
          },
        }
      : {}),
  };
}

/** Prefill for a deduped row: the saved profile wins, the shadowed config entry fills a missing key. */
export function sshConnectPrefillFromEntry(entry: SshProfileEntryV1, panel: SshProfilesPanelModelV1) {
  const prefill = sshConnectPrefillFromProfile(entry.profile, panel, entry.source);
  const config = entry.configProfile;
  const usesKey = !prefill.authMethod || prefill.authMethod === "auto" || prefill.authMethod === "key";
  if (!config || prefill.identityFile || !usesKey || !config.identityFile) return prefill;
  return {
    ...prefill,
    identityFile: config.identityFile,
    certificateFile: prefill.certificateFile || config.certificateFile,
  };
}

export function hostProfileButtonLabel(profile: SshHostProfile): string {
  const label = profile.label.trim();
  if (label) return label;
  return profile.port === 22 ? `${profile.user}@${profile.host}` : `${profile.user}@${profile.host}:${profile.port}`;
}
