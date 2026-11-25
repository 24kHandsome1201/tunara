export function splitShellCommandSegments(commandLine: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (let index = 0; index < commandLine.length; index += 1) {
    const char = commandLine[index];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    const pair = commandLine.slice(index, index + 2);
    if (pair === "&&" || pair === "||") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      index += 1;
      continue;
    }
    if (char === ";" || char === "|") {
      if (current.trim()) segments.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

export function tokenizeShellWords(segment: string): string[];
export function tokenizeShellWords(segment: string, strict: true): string[] | null;
export function tokenizeShellWords(segment: string, strict = false): string[] | null {
  const words: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let started = false;
  const push = () => {
    if (current || (strict && started)) words.push(current);
    current = "";
    started = false;
  };
  for (const char of segment) {
    if (escaped) {
      if (strict && quote === '"' && !'$"`\\'.includes(char)) current += "\\";
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaped = true;
      started = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) push();
    else current += char;
  }
  if (strict && (quote || escaped)) return null;
  push();
  return words;
}

export function shellCommandName(token: string): string {
  return token.toLowerCase().split("/").pop() ?? "";
}

/**
 * Build the one fixed command used by File Explorer's "Open in terminal".
 * The caller either starts the terminal in the file's parent directory or
 * supplies an absolute directory for an idle terminal to enter first. Reject
 * terminal controls, quote every untrusted value as one POSIX shell word, and
 * keep `--` between less options and the untrusted name.
 */
export function terminalFileViewerCommand(fileName: string, directory?: string): string | null {
  const hasTerminalControl = (value: string) => /[\u0000-\u001f\u007f-\u009f]/.test(value);
  const quote = (value: string) => `'${value.split("'").join(`'"'"'`)}'`;
  if (!fileName || hasTerminalControl(fileName)) return null;
  const viewer = `less -- ${quote(fileName)}`;
  if (directory === undefined) return viewer;
  if (!directory.startsWith("/") || hasTerminalControl(directory)) return null;
  return `cd ${quote(directory)} && ${viewer}`;
}
