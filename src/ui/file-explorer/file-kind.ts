export const FILE_KIND_FAMILIES = [
  "code",
  "data",
  "doc",
  "image",
  "config",
  "script",
  "log",
] as const;

export type FileKindFamily = (typeof FILE_KIND_FAMILIES)[number];

const EXTENSION_FAMILY: Record<string, FileKindFamily> = {
  ts: "code",
  tsx: "code",
  js: "code",
  jsx: "code",
  mjs: "code",
  cjs: "code",
  cts: "code",
  mts: "code",
  java: "code",
  kt: "code",
  kts: "code",
  go: "code",
  rs: "code",
  c: "code",
  h: "code",
  hh: "code",
  hpp: "code",
  cpp: "code",
  cc: "code",
  cxx: "code",
  cs: "code",
  swift: "code",
  rb: "code",
  php: "code",
  scala: "code",
  vue: "code",
  svelte: "code",
  html: "code",
  htm: "code",
  css: "code",
  scss: "code",
  sass: "code",
  less: "code",
  sql: "code",
  graphql: "code",
  gql: "code",
  proto: "code",
  zig: "code",
  nim: "code",
  dart: "code",
  lua: "code",
  r: "code",
  jl: "code",
  elm: "code",
  hs: "code",
  ex: "code",
  exs: "code",
  clj: "code",
  fs: "code",
  fsx: "code",
  wasm: "code",

  json: "data",
  jsonc: "data",
  jsonl: "data",
  ndjson: "data",
  yaml: "data",
  yml: "data",
  toml: "data",
  csv: "data",
  tsv: "data",
  xml: "data",

  md: "doc",
  markdown: "doc",
  mdx: "doc",
  txt: "doc",
  text: "doc",
  pdf: "doc",
  rtf: "doc",
  rst: "doc",
  adoc: "doc",
  org: "doc",
  tex: "doc",
  doc: "doc",
  docx: "doc",
  odt: "doc",

  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  ico: "image",
  bmp: "image",
  avif: "image",
  heic: "image",
  heif: "image",
  tif: "image",
  tiff: "image",

  conf: "config",
  cfg: "config",
  ini: "config",
  plist: "config",
  properties: "config",
  env: "config",
  nix: "config",
  cmake: "config",
  editorconfig: "config",

  sh: "script",
  bash: "script",
  zsh: "script",
  fish: "script",
  py: "script",
  pyw: "script",
  pyi: "script",
  ipynb: "script",
  ps1: "script",
  bat: "script",
  cmd: "script",

  log: "log",
  out: "log",
  err: "log",
};

const SPECIAL_NAMES: Record<string, FileKindFamily> = {
  dockerfile: "config",
  containerfile: "config",
  makefile: "config",
  gnumakefile: "config",
  "cmakelists.txt": "config",
  procfile: "config",
  justfile: "config",
  gemfile: "config",
  rakefile: "config",
  vagrantfile: "config",
  license: "doc",
  copying: "doc",
  changelog: "doc",
  readme: "doc",
  authors: "doc",
  notice: "doc",
};

const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "composer.lock",
  "gemfile.lock",
  "poetry.lock",
  "flake.lock",
  "go.sum",
]);

function fileBasename(pathOrName: string): string {
  const trimmed = pathOrName.replace(/[\\/]+$/, "");
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

function isLockfileName(lower: string): boolean {
  return LOCKFILE_NAMES.has(lower)
    || lower.endsWith(".lock")
    || lower.endsWith("-lock.json")
    || lower.endsWith("-lock.yaml")
    || lower.endsWith("-lock.yml");
}

function isEnvName(lower: string): boolean {
  return lower === "env" || lower.startsWith(".env") || lower.endsWith(".env") || lower.includes(".env.");
}

export function fileKindFamily(pathOrName: string): FileKindFamily | null {
  const name = fileBasename(pathOrName);
  if (!name) return null;
  const lower = name.toLowerCase();

  if (isLockfileName(lower) || isEnvName(lower)) return "config";
  if (lower.startsWith(".")) return "config";

  const special = SPECIAL_NAMES[lower];
  if (special) return special;

  const dot = lower.lastIndexOf(".");
  if (dot <= 0 || dot === lower.length - 1) return null;
  return EXTENSION_FAMILY[lower.slice(dot + 1)] ?? null;
}

export function fileKindTint(pathOrName: string): string | undefined {
  const family = fileKindFamily(pathOrName);
  return family ? `var(--c-file-${family})` : undefined;
}

const NUMERIC_CELL = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export function isNumericTableColumn(rows: readonly (readonly string[])[], columnIndex: number): boolean {
  let seen = 0;
  for (const row of rows) {
    const cell = row[columnIndex]?.trim() ?? "";
    if (!cell) continue;
    seen += 1;
    if (!NUMERIC_CELL.test(cell)) return false;
  }
  return seen > 0;
}
