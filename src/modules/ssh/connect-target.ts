import { parseSshPort, type SshHostProfile } from "./hosts-model.ts";

/** One-box SSH target. User may be empty when the text is only a host or alias. */
export interface ParsedSshTarget {
  user: string;
  host: string;
  port?: number;
}

export function formatSshTarget(user: string, host: string, port = 22): string {
  const identity = user ? `${user}@${host}` : host;
  return port === 22 ? identity : `${identity}:${port}`;
}

/**
 * Parse `user@host[:port]`, `host[:port]`, or `[ipv6]:port`.
 * Incomplete fragments (empty host, invalid port) return null.
 */
export function sshTargetHasInvalidPort(raw: string): boolean {
  const value = raw.trim();
  const match = value.match(/:(\d+)$/);
  return Boolean(match && parseSshPort(match[1]) === null);
}

export function parseSshTarget(raw: string): ParsedSshTarget | null {
  const value = raw.trim();
  if (!value) return null;

  const at = value.lastIndexOf("@");
  const user = at > 0 ? value.slice(0, at).trim() : "";
  const rest = (at > 0 ? value.slice(at + 1) : value).trim();
  if (!rest || user.includes(" ")) return null;

  if (rest.startsWith("[")) {
    const end = rest.indexOf("]");
    if (end < 2) return null;
    const host = rest.slice(1, end).trim();
    const tail = rest.slice(end + 1);
    if (!host) return null;
    if (!tail) return { user, host };
    if (!tail.startsWith(":")) return null;
    const port = parseSshPort(tail.slice(1));
    if (port === null) return null;
    return { user, host, port };
  }

  const colon = rest.lastIndexOf(":");
  if (colon > 0 && /^\d+$/.test(rest.slice(colon + 1))) {
    const port = parseSshPort(rest.slice(colon + 1));
    if (port === null) return null;
    const host = rest.slice(0, colon).trim();
    if (!host) return null;
    return { user, host, port };
  }

  return { user, host: rest };
}

export function sshTargetHaystack(profile: SshHostProfile): string {
  return `${profile.label} ${profile.user}@${profile.host}:${profile.port}`.toLowerCase();
}

export function profileMatchesTarget(profile: SshHostProfile, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return sshTargetHaystack(profile).includes(normalized);
}

/** Exact match on label, alias-like host, or user@host[:port]. */
export function exactSshProfileMatch(profiles: SshHostProfile[], raw: string): SshHostProfile | undefined {
  const value = raw.trim().toLowerCase();
  if (!value) return undefined;
  const parsed = parseSshTarget(raw);
  return profiles.find((profile) => {
    const label = profile.label.trim().toLowerCase();
    const host = profile.host.toLowerCase();
    const identity = formatSshTarget(profile.user, profile.host, profile.port).toLowerCase();
    const identityDefault = formatSshTarget(profile.user, profile.host, 22).toLowerCase();
    if (label === value || host === value || identity === value || identityDefault === value) return true;
    if (!parsed) return false;
    return parsed.host.toLowerCase() === host
      && (parsed.user ? parsed.user === profile.user : true)
      && (parsed.port ?? 22) === profile.port;
  });
}

export function filterSshProfiles(profiles: SshHostProfile[], query: string, limit = 12): SshHostProfile[] {
  return profiles.filter((profile) => profileMatchesTarget(profile, query)).slice(0, limit);
}
