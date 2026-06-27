export interface TerminalFileLinkMatch {
  text: string;
  rawPath: string;
  line: number;
  column?: number;
  startIndex: number;
  endIndex: number;
}

const FILE_LINK_RE = /(^|[\s([{"'=])((?:(?:~|\.{1,2}|\/)?(?:[A-Za-z0-9_@%+.,=-]+\/)+[A-Za-z0-9_@%+.,=-]+)|(?:[A-Za-z0-9_@%+.,=-]+\.(?:c|cc|cpp|cs|css|go|h|hpp|html|java|js|jsx|json|kt|mjs|py|rb|rs|scss|swift|toml|ts|tsx|txt|vue|yaml|yml))):(\d{1,7})(?::(\d{1,5}))?(?=$|[\s)\]}",;'.])/gi;

export function findTerminalFileLinkMatches(text: string): TerminalFileLinkMatch[] {
  const matches: TerminalFileLinkMatch[] = [];
  FILE_LINK_RE.lastIndex = 0;
  for (const match of text.matchAll(FILE_LINK_RE)) {
    const rawPath = match[2];
    const line = Number.parseInt(match[3], 10);
    const column = match[4] ? Number.parseInt(match[4], 10) : undefined;
    if (!rawPath || !Number.isFinite(line) || line <= 0) continue;
    if (column !== undefined && (!Number.isFinite(column) || column <= 0)) continue;

    const linkText = `${rawPath}:${match[3]}${match[4] ? `:${match[4]}` : ""}`;
    const startIndex = (match.index ?? 0) + (match[1]?.length ?? 0);
    matches.push({
      text: linkText,
      rawPath,
      line,
      column,
      startIndex,
      endIndex: startIndex + linkText.length,
    });
  }
  return matches;
}

export function resolveTerminalFileLinkPath(rawPath: string, cwd: string | undefined): string {
  if (rawPath.startsWith("/") || rawPath.startsWith("~")) return rawPath;
  const base = cwd && cwd.trim() ? cwd : "~";
  return normalizePosixPath(`${base.replace(/\/+$/, "")}/${rawPath}`);
}

function normalizePosixPath(path: string): string {
  const root = path.startsWith("/") ? "/" : path.startsWith("~/") ? "~/" : "";
  const parts = path.slice(root.length).split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === ".." && stack.length > 0 && stack[stack.length - 1] !== "..") {
      stack.pop();
      continue;
    }
    if (part !== ".." || !root) stack.push(part);
  }
  const body = stack.join("/");
  if (root === "/") return `/${body}`.replace(/\/$/, "") || "/";
  if (root === "~/") return body ? `~/${body}` : "~";
  return body || ".";
}
