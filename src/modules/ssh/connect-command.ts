import { tokenizeShellWords } from "../terminal/lib/shell-command.ts";
import { formatSshTarget, parseSshTarget, sshTargetHasInvalidPort, type ParsedSshTarget } from "./connect-target.ts";
import { parseSshPort, sshProfileEntries, type SshHostProfile, type SshProfilesPanelModelV1 } from "./hosts-model.ts";

interface SshCommand {
  destination: string;
  target: ParsedSshTarget | null;
  invalidPort: boolean;
  identityFile?: string;
  certificateFile?: string;
  jump?: string;
}

// OpenSSH options that consume an operand, including those not used by this dialog.
const OPTIONS_WITH_VALUE = "BbcDEeFIiJLlmOoPpQRSWw";

export function isSshCommandInput(raw: string): boolean {
  return /^ssh\s/.test(raw.trimStart());
}

export function parseSshCommand(raw: string): SshCommand | null {
  if (!isSshCommandInput(raw) || /[\u0000-\u0008\u000a-\u001f\u007f]/.test(raw)) return null;
  const words = tokenizeShellWords(raw, true);
  if (!words) return null;
  let destination = "";
  let portText: string | undefined;
  let user: string | undefined;
  let identityFile: string | undefined;
  let certificateFile: string | undefined;
  let jump: string | undefined;
  let options = true;
  for (let index = 1; index < words.length; index++) {
    const word = words[index];
    if (options && word === "--") {
      options = false;
    } else if (options && word.startsWith("-") && !word.startsWith("--") && word.length > 1) {
      for (let flagIndex = 1; flagIndex < word.length; flagIndex++) {
        const flag = word[flagIndex];
        if (!OPTIONS_WITH_VALUE.includes(flag)) continue;
        const value = word.slice(flagIndex + 1) || words[++index];
        if (value === undefined || !value.trim()) return null;
        if (flag === "p") portText ??= value;
        if (flag === "l") user ??= value;
        if (flag === "i") identityFile ??= value;
        if (flag === "J") jump ??= value;
        if (flag === "o") {
          const option = value.match(/^(port|user|identityfile|certificatefile|proxyjump)(?:\s*=\s*|\s+)(.+)$/i);
          if (option) {
            const [, key, rawOptionValue] = option;
            const quotedWords = /["']/.test(rawOptionValue) ? tokenizeShellWords(rawOptionValue, true) : [rawOptionValue];
            if (quotedWords?.length !== 1 || !quotedWords[0]) return null;
            const optionValue = quotedWords[0];
            switch (key.toLowerCase()) {
              case "port": portText ??= optionValue; break;
              case "user": user ??= optionValue; break;
              case "identityfile": identityFile ??= optionValue; break;
              case "certificatefile": certificateFile ??= optionValue; break;
              case "proxyjump": jump ??= optionValue; break;
            }
          }
        }
        break;
      }
    } else if (!options || !word.startsWith("-")) {
      if (destination) break;
      if (!word || /[\s;&|<>]/.test(word)) return null;
      destination = word;
      const destinationUser = parseSshTarget(destination)?.user;
      if (destinationUser) user ??= destinationUser;
    }
  }
  if (!destination) return null;
  const parsed = parseSshTarget(destination);
  const explicitPort = portText === undefined ? undefined : parseSshPort(portText);
  const invalidPort = explicitPort === null || sshTargetHasInvalidPort(destination);
  const effectiveUser = user ?? parsed?.user ?? "";
  const target = parsed && !invalidPort && !/[\s@;&|<>]/.test(effectiveUser)
    ? { ...parsed, user: effectiveUser, port: explicitPort ?? parsed.port }
    : null;
  return { destination, target, invalidPort, identityFile, certificateFile, jump };
}

export function sshCommandMatchTarget(command: SshCommand): string {
  const target = command.target;
  return target ? formatSshTarget(target.user, target.host, target.port) : command.destination;
}

export function matchingSshJumpProfiles(model: SshProfilesPanelModelV1, raw: string): SshHostProfile[] {
  const target = parseSshTarget(raw);
  if (!target || /[\s,]/.test(raw)) return [];
  const host = target.host.toLowerCase();
  const matchesOptions = (profile: SshHostProfile) => (!target.user || target.user === profile.user)
    && (target.port === undefined || target.port === profile.port);
  const matchingEntries = (matchHost: (profile: SshHostProfile) => boolean) => {
    const matches = (profile: SshHostProfile) => matchHost(profile) && matchesOptions(profile);
    return sshProfileEntries({
      ...model,
      savedProfiles: model.savedProfiles.filter(matches),
      configProfiles: model.configProfiles.filter(matches),
    }).map(({ profile, configProfile }) => {
      if (!configProfile || profile.identityFile || profile.authMethod === "password") return profile;
      return {
        ...profile,
        identityFile: configProfile.identityFile,
        ...(!profile.certificateFile && configProfile.certificateFile ? { certificateFile: configProfile.certificateFile } : {}),
      };
    });
  };
  const aliases = matchingEntries((profile) => host === profile.label.trim().toLowerCase());
  return aliases.length > 0 ? aliases : matchingEntries((profile) => host === profile.host.toLowerCase());
}
