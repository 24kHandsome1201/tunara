import type { Terminal } from "@xterm/xterm";

export interface TerminalLigatureRegistration {
  dispose: () => void;
}

const PROGRAMMING_LIGATURES = [
  "<---->", "<====>", "<--->", "<===>", "!===", "<---", "--->", "<-->",
  "<===", "===>", "<==>", "<->", "<=>", "!==", "<--", "<<-", "->>",
  "-->", "<==", "<<=", "=>>", "==>", ">>=", "<~~", "</>", "~~>", "===",
  "<*>", "<|>", "<!---", "<-", "->", "<=", "=>", ">=", "::", "==", "!=",
  "/=", "~=", "<>", "<:", ":=", "*=", "*+", "<*", "*>", "<|", "|>", "+*",
  "=*", "=:", ":>", "</", "/>", "+++", "<!--", "&&", "||", "??", "?.",
] as const;

const LIGATURE_RE = new RegExp(PROGRAMMING_LIGATURES.map(escapeRegex).join("|"), "g");

export function findProgrammingLigatureRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  LIGATURE_RE.lastIndex = 0;
  for (const match of text.matchAll(LIGATURE_RE)) {
    const start = match.index ?? 0;
    ranges.push([start, start + match[0].length]);
  }
  return ranges;
}

export function registerTerminalLigatures(term: Terminal): TerminalLigatureRegistration {
  const joinerId = term.registerCharacterJoiner(findProgrammingLigatureRanges);
  return {
    dispose: () => term.deregisterCharacterJoiner(joinerId),
  };
}

function escapeRegex(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}
