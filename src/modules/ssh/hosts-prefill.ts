import type { SshHostProfile, SshProfilesPanelModelV1 } from "./hosts-model.ts";
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

export function hostProfileButtonLabel(profile: SshHostProfile): string {
  const label = profile.label.trim();
  if (label) return label;
  return profile.port === 22 ? `${profile.user}@${profile.host}` : `${profile.user}@${profile.host}:${profile.port}`;
}
