export const SHIKI_LANGUAGES = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "yaml",
  "toml",
  "rust",
  "python",
  "go",
  "bash",
  "css",
  "html",
  "sql",
  "dockerfile",
] as const;

export type ShikiLanguage = (typeof SHIKI_LANGUAGES)[number];

export type DetectedLanguage = ShikiLanguage | "markdown" | "log";

const EXTENSION_LANGUAGE: Record<string, DetectedLanguage> = {
  ts: "typescript",
  cts: "typescript",
  mts: "typescript",
  tsx: "tsx",
  js: "javascript",
  cjs: "javascript",
  mjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  rs: "rust",
  py: "python",
  pyw: "python",
  pyi: "python",
  go: "go",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  ksh: "bash",
  css: "css",
  html: "html",
  htm: "html",
  sql: "sql",
  dockerfile: "dockerfile",
  md: "markdown",
  mdx: "markdown",
};

const SHEBANG_LANGUAGE: Array<{ test: RegExp; language: ShikiLanguage }> = [
  { test: /\bpython(?:\d+(?:\.\d+)*)?\b/i, language: "python" },
  { test: /\b(?:ts-node|tsx)\b/i, language: "typescript" },
  { test: /\b(?:node|nodejs|deno|bun)\b/i, language: "javascript" },
  { test: /\b(?:bash|zsh|ksh|dash|sh)\b/i, language: "bash" },
];

const LOG_NAME = /\.log(?:\.\d+)?$/i;
const LOG_CANDIDATE = /\.(?:out|err|txt)$/i;

const TIMESTAMP_START =
  /^(?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}|[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}|\[\d{2}\/[A-Za-z]{3}\/\d{4}:\d{2}:\d{2}:\d{2})/;
const LEVEL_START = /^(?:ERROR|FATAL|CRITICAL|PANIC|WARN(?:ING)?|INFO|DEBUG|TRACE|NOTICE)\b/i;

function fileNameOf(pathOrName: string): string {
  const normalized = pathOrName.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0 || dot === fileName.length - 1) return "";
  return fileName.slice(dot + 1).toLowerCase();
}

export function isAlwaysLogFileName(fileName: string): boolean {
  return LOG_NAME.test(fileName);
}

export function looksLikeLogLine(line: string): boolean {
  const trimmed = line.trimStart();
  if (!trimmed) return false;
  return TIMESTAMP_START.test(trimmed) || LEVEL_START.test(trimmed);
}

/** True when ≥ 30% of the first 50 non-empty-or-any lines look like log preamble. */
export function looksLikeLogContent(content: string): boolean {
  const sample: string[] = [];
  let offset = 0;
  while (offset <= content.length && sample.length < 50) {
    const next = content.indexOf("\n", offset);
    const line = next < 0 ? content.slice(offset) : content.slice(offset, next);
    sample.push(line);
    if (next < 0) break;
    offset = next + 1;
  }
  if (sample.length === 0) return false;
  let hits = 0;
  for (const line of sample) {
    if (looksLikeLogLine(line)) hits += 1;
  }
  return hits / sample.length >= 0.3;
}

function languageFromShebang(content: string): ShikiLanguage | null {
  if (!content.startsWith("#!")) return null;
  const newline = content.indexOf("\n");
  const line = newline < 0 ? content : content.slice(0, newline);
  for (const entry of SHEBANG_LANGUAGE) {
    if (entry.test.test(line)) return entry.language;
  }
  return null;
}

function languageFromFileName(fileName: string): DetectedLanguage | null {
  if (!fileName) return null;
  if (isAlwaysLogFileName(fileName)) return "log";
  const lower = fileName.toLowerCase();
  if (lower === "dockerfile" || lower.startsWith("dockerfile.")) return "dockerfile";
  if (lower === "makefile") return null;
  const extension = extensionOf(fileName);
  if (!extension) return null;
  return EXTENSION_LANGUAGE[extension] ?? null;
}

export function detectLanguage(fileName: string, content = ""): DetectedLanguage | null {
  const baseName = fileNameOf(fileName);
  const fromName = languageFromFileName(baseName);
  if (fromName) return fromName;
  const fromShebang = languageFromShebang(content);
  if (fromShebang) return fromShebang;
  if (LOG_CANDIDATE.test(baseName) && looksLikeLogContent(content)) return "log";
  return null;
}
