#!/usr/bin/env node
/**
 * Audit locale dictionaries against `t()` / `useT()` (and aliases) in `src/`
 * plus any i18n-key string literals in `src-tauri/src`.
 *
 * Usage:
 *   node scripts/i18n-audit.mjs
 *   node scripts/i18n-audit.mjs --json
 *   node scripts/i18n-audit.mjs --fail-on-dead
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT = resolve(here, "..");

const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const RUST_EXT = ".rs";
const KEY_LIKE = /^[A-Za-z][A-Za-z0-9_.-]*\.[A-Za-z0-9_.-]+$/;
const IMPORT_BRACES_RE = /import\s*(?:type\s+)?\{([^}]+)\}\s*from\s*["']([^"']+)["']/g;
const USE_T_ASSIGN_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*useT\s*\(/g;
const TYPE_IMPORT_RE = /^type\s+/;

export function flattenKeys(value, prefix = "") {
  const keys = [];
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [name, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${name}` : name;
      if (child && typeof child === "object" && !Array.isArray(child)) {
        keys.push(...flattenKeys(child, path));
      } else {
        keys.push(path);
      }
    }
  }
  return keys;
}

export function loadLocaleKeys(root, file) {
  const parsed = JSON.parse(readFileSync(join(root, file), "utf8"));
  return new Set(flattenKeys(parsed));
}

function isI18nModule(specifier) {
  return /(?:^|\/)i18n(?:\/|$)/.test(specifier.replaceAll("\\", "/"));
}

function isTestPath(relPath) {
  const normalized = relPath.replaceAll("\\", "/");
  if (/(^|\/)(?:__tests?__|tests?)(\/|$)/i.test(normalized)) return true;
  return /\.(?:test|spec)\.[^.]+$/.test(normalized);
}

function walkFiles(dir, predicate, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "target" || entry.name === "dist") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "locales" && dir.replaceAll("\\", "/").endsWith("/i18n")) continue;
      if (entry.name === "gen" && dir.replaceAll("\\", "/").endsWith("src-tauri")) continue;
      walkFiles(full, predicate, out);
    } else if (entry.isFile() && predicate(full)) {
      out.push(full);
    }
  }
  return out;
}

function skipString(source, i, quote) {
  let index = i + 1;
  while (index < source.length) {
    const ch = source[index];
    if (ch === "\\") {
      index += 2;
      continue;
    }
    if (ch === quote) return index + 1;
    if (quote === "`" && ch === "$" && source[index + 1] === "{") {
      index = skipTemplateExpression(source, index + 2);
      continue;
    }
    index += 1;
  }
  return source.length;
}

function skipTemplateExpression(source, i) {
  let depth = 1;
  let index = i;
  while (index < source.length && depth > 0) {
    const ch = source[index];
    if (ch === "'" || ch === "\"" || ch === "`") {
      index = skipString(source, index, ch);
      continue;
    }
    if (ch === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index);
      if (index < 0) return source.length;
      index += 1;
      continue;
    }
    if (ch === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    index += 1;
  }
  return index;
}

function extractFirstArg(source, openParen) {
  let index = openParen + 1;
  const start = index;
  let depth = 1;
  while (index < source.length && depth > 0) {
    const ch = source[index];
    if (ch === "'" || ch === "\"" || ch === "`") {
      index = skipString(source, index, ch);
      continue;
    }
    if (ch === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index);
      if (index < 0) break;
      index += 1;
      continue;
    }
    if (ch === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if (ch === "(" || ch === "{" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) break;
    } else if (ch === "," && depth === 1) break;
    index += 1;
  }
  return source.slice(start, index).trim();
}

function collectQuotedStrings(text) {
  const out = [];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch !== "'" && ch !== "\"") continue;
    const start = i + 1;
    i = skipString(text, i, ch) - 1;
    out.push(text.slice(start, i));
  }
  return out;
}

function collectTemplates(text) {
  const out = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "`") continue;
    const start = i + 1;
    i = skipString(text, i, "`") - 1;
    out.push(text.slice(start, i));
  }
  return out;
}

function unescapeJsString(value) {
  return value.replace(/\\([\\'"nrt])/g, (_, ch) => {
    if (ch === "n") return "\n";
    if (ch === "r") return "\r";
    if (ch === "t") return "\t";
    return ch;
  });
}

function splitTemplate(raw) {
  const staticParts = [];
  let current = "";
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === "$" && raw[i + 1] === "{") {
      staticParts.push(current);
      current = "";
      i = skipTemplateExpression(raw, i + 2) - 1;
      continue;
    }
    if (raw[i] === "\\" && i + 1 < raw.length) {
      current += raw[i + 1];
      i += 1;
      continue;
    }
    current += raw[i];
  }
  staticParts.push(current);
  return staticParts;
}

export function parseDynamicPattern(rawTemplate) {
  const parts = splitTemplate(rawTemplate);
  if (parts.length < 2) {
    const key = parts[0] ?? "";
    return key ? { kind: "static", key } : null;
  }
  const leading = parts[0];
  const trailing = parts[parts.length - 1] ?? "";
  return {
    kind: "dynamic",
    leading,
    trailing,
    raw: rawTemplate,
  };
}

function translatorNames(source) {
  const names = new Set();
  IMPORT_BRACES_RE.lastIndex = 0;
  for (const match of source.matchAll(IMPORT_BRACES_RE)) {
    const specifier = match[2];
    if (!isI18nModule(specifier)) continue;
    for (const raw of match[1].split(",")) {
      const spec = raw.trim();
      if (!spec || TYPE_IMPORT_RE.test(spec)) continue;
      const alias = spec.split(/\s+as\s+/);
      const imported = alias[0].trim();
      const local = (alias[1] ?? alias[0]).trim();
      if (imported === "t" && local) names.add(local);
    }
  }
  USE_T_ASSIGN_RE.lastIndex = 0;
  for (const match of source.matchAll(USE_T_ASSIGN_RE)) names.add(match[1]);
  return names;
}

function findTranslatorCalls(source, names) {
  const calls = [];
  if (names.size === 0) return calls;
  const nameRe = new RegExp(`\\b(${[...names].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\s*\\(`, "g");
  for (const match of source.matchAll(nameRe)) {
    const open = match.index + match[0].length - 1;
    calls.push(extractFirstArg(source, open));
  }
  return calls;
}

function isKeyLike(value) {
  return KEY_LIKE.test(value);
}

function collectQuotedKeysInFile(source) {
  const keys = [];
  for (const raw of collectQuotedStrings(source)) {
    const value = unescapeJsString(raw);
    if (isKeyLike(value)) keys.push(value);
  }
  return keys;
}

function rustQuotedStrings(source) {
  const out = [];
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch !== "\"") continue;
    if (i > 0 && source[i - 1] === "r") {
      // raw string r"..." / r#"..."# — skip for simplicity via the same closer
    }
    let j = i + 1;
    let value = "";
    while (j < source.length) {
      if (source[j] === "\\") {
        value += source[j + 1] ?? "";
        j += 2;
        continue;
      }
      if (source[j] === "\"") break;
      value += source[j];
      j += 1;
    }
    out.push(value);
    i = j;
  }
  return out;
}

function isUsableDynamicPrefix(leading) {
  return /^[A-Za-z][\w-]*(?:\.[\w-]+)*\.?$/.test(leading) && leading.includes(".");
}

function matchesDynamic(key, pattern) {
  if (!isUsableDynamicPrefix(pattern.leading)) return false;
  if (!key.startsWith(pattern.leading)) return false;
  const rest = key.slice(pattern.leading.length);
  if (!pattern.trailing) return rest.length > 0;
  if (!key.endsWith(pattern.trailing)) return false;
  const middle = key.slice(pattern.leading.length, key.length - pattern.trailing.length);
  return middle.length > 0;
}

function topPrefix(key) {
  const dot = key.indexOf(".");
  return dot === -1 ? key : key.slice(0, dot);
}

function groupByPrefix(keys) {
  const groups = new Map();
  for (const key of keys) {
    const prefix = topPrefix(key);
    const list = groups.get(prefix);
    if (list) list.push(key);
    else groups.set(prefix, [key]);
  }
  for (const list of groups.values()) list.sort();
  return [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([prefix, list]) => ({ prefix, count: list.length, keys: list }));
}

export function auditI18n(root = DEFAULT_ROOT) {
  const enFile = "src/modules/i18n/locales/en.json";
  const zhFile = "src/modules/i18n/locales/zh-CN.json";
  const enKeys = loadLocaleKeys(root, enFile);
  const zhKeys = loadLocaleKeys(root, zhFile);
  const allLocaleKeys = new Set([...enKeys, ...zhKeys]);

  const staticRefs = new Set();
  const missing = new Set();
  const dynamicPatterns = [];
  const dynamicSeen = new Set();

  const rememberDynamic = (pattern) => {
    const id = `${pattern.leading}\0${pattern.trailing}`;
    if (dynamicSeen.has(id)) return;
    dynamicSeen.add(id);
    dynamicPatterns.push(pattern);
  };

  const srcRoot = join(root, "src");
  const srcFiles = walkFiles(srcRoot, (full) => {
    const rel = relative(root, full).replaceAll("\\", "/");
    if (isTestPath(rel)) return false;
    if (rel.startsWith("src/modules/i18n/locales/")) return false;
    return SOURCE_EXTS.has(extname(full));
  });

  for (const file of srcFiles) {
    const source = readFileSync(file, "utf8");
    const names = translatorNames(source);
    const calls = findTranslatorCalls(source, names);

    for (const arg of calls) {
      for (const raw of collectQuotedStrings(arg)) {
        const key = unescapeJsString(raw);
        if (!isKeyLike(key)) continue;
        if (allLocaleKeys.has(key)) staticRefs.add(key);
        else missing.add(key);
      }
      for (const raw of collectTemplates(arg)) {
        const parsed = parseDynamicPattern(raw);
        if (!parsed) continue;
        if (parsed.kind === "static") {
          if (allLocaleKeys.has(parsed.key)) staticRefs.add(parsed.key);
          else if (isKeyLike(parsed.key)) missing.add(parsed.key);
          continue;
        }
        rememberDynamic(parsed);
      }
    }

    // Indirect key literals (titleKey maps, failure-key helpers, fieldAlert args).
    for (const key of collectQuotedKeysInFile(source)) {
      if (allLocaleKeys.has(key)) staticRefs.add(key);
    }
  }

  const rustRoot = join(root, "src-tauri");
  const rustFiles = walkFiles(rustRoot, (full) => {
    const rel = relative(root, full).replaceAll("\\", "/");
    if (rel.startsWith("src-tauri/target/") || rel.startsWith("src-tauri/gen/")) return false;
    if (isTestPath(rel)) return false;
    return extname(full) === RUST_EXT;
  });

  const rustRefs = [];
  for (const file of rustFiles) {
    const source = readFileSync(file, "utf8");
    for (const value of rustQuotedStrings(source)) {
      if (!allLocaleKeys.has(value)) continue;
      staticRefs.add(value);
      rustRefs.push({ file: relative(root, file).replaceAll("\\", "/"), key: value });
    }
  }

  const dynamicKeys = new Set();
  const unmatchedDynamic = [];
  for (const pattern of dynamicPatterns) {
    let matched = 0;
    for (const key of allLocaleKeys) {
      if (matchesDynamic(key, pattern)) {
        dynamicKeys.add(key);
        matched += 1;
      }
    }
    if (matched === 0) unmatchedDynamic.push(pattern);
  }

  const dead = [...allLocaleKeys].filter((key) => !staticRefs.has(key) && !dynamicKeys.has(key)).sort();
  const onlyInEn = [...enKeys].filter((key) => !zhKeys.has(key)).sort();
  const onlyInZhCN = [...zhKeys].filter((key) => !enKeys.has(key)).sort();
  const usedStatic = [...staticRefs].sort();
  const usedDynamic = [...dynamicKeys].sort();

  const dynamicPrefixes = dynamicPatterns.map((pattern) => {
    const label = pattern.trailing
      ? `${pattern.leading}\${…}${pattern.trailing}`
      : `${pattern.leading}\${…}`;
    return {
      label,
      leading: pattern.leading,
      trailing: pattern.trailing,
      raw: pattern.raw,
    };
  }).sort((a, b) => a.label.localeCompare(b.label));

  return {
    localeCounts: { en: enKeys.size, "zh-CN": zhKeys.size },
    usedStatic,
    usedDynamic,
    dead,
    deadByPrefix: groupByPrefix(dead),
    dynamicPrefixes,
    unmatchedDynamicPrefixes: unmatchedDynamic.map((pattern) => ({
      leading: pattern.leading,
      trailing: pattern.trailing,
      raw: pattern.raw,
    })),
    onlyInEn,
    onlyInZhCN,
    missing: [...missing].sort(),
    rustRefs,
    scanned: { srcFiles: srcFiles.length, rustFiles: rustFiles.length },
  };
}

export function formatReport(result) {
  const lines = [];
  lines.push("i18n audit");
  lines.push("==========");
  lines.push(`en: ${result.localeCounts.en} keys`);
  lines.push(`zh-CN: ${result.localeCounts["zh-CN"]} keys`);
  lines.push(`static refs: ${result.usedStatic.length}`);
  lines.push(`dynamic-matched keys: ${result.usedDynamic.length}`);
  lines.push(`dead keys: ${result.dead.length}`);
  lines.push("");
  lines.push("Dead keys by prefix (top 15):");
  const top = result.deadByPrefix.slice(0, 15);
  if (top.length === 0) lines.push("  (none)");
  for (const group of top) {
    lines.push(`  ${group.prefix.padEnd(16)} ${group.count}`);
  }
  lines.push("");
  lines.push("Dynamic prefixes:");
  if (result.dynamicPrefixes.length === 0) lines.push("  (none)");
  for (const prefix of result.dynamicPrefixes) {
    lines.push(`  ${prefix.label}`);
  }
  if (result.unmatchedDynamicPrefixes.length > 0) {
    lines.push("");
    lines.push("Dynamic prefixes with no matching locale keys:");
    for (const prefix of result.unmatchedDynamicPrefixes) {
      lines.push(`  ${prefix.leading}\${…}${prefix.trailing}`);
    }
  }
  lines.push("");
  lines.push("Locale-only keys:");
  lines.push(`  only in en: ${result.onlyInEn.length}${result.onlyInEn.length ? ` (${result.onlyInEn.join(", ")})` : ""}`);
  lines.push(`  only in zh-CN: ${result.onlyInZhCN.length}${result.onlyInZhCN.length ? ` (${result.onlyInZhCN.join(", ")})` : ""}`);
  lines.push("");
  lines.push("Referenced but missing:");
  if (result.missing.length === 0) lines.push("  (none)");
  else for (const key of result.missing) lines.push(`  ${key}`);
  if (result.rustRefs.length > 0) {
    lines.push("");
    lines.push("Rust-side key refs:");
    for (const ref of result.rustRefs) lines.push(`  ${ref.file}: ${ref.key}`);
  } else {
    lines.push("");
    lines.push("Rust-side key refs: (none)");
  }
  return lines.join("\n");
}

function parseArgs(argv) {
  return {
    json: argv.includes("--json"),
    failOnDead: argv.includes("--fail-on-dead"),
  };
}

export function main(argv = process.argv.slice(2), root = DEFAULT_ROOT) {
  const options = parseArgs(argv);
  const result = auditI18n(root);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReport(result)}\n`);
  }
  if (options.failOnDead && result.dead.length > 0) {
    process.exitCode = 1;
  }
  return result;
}

const invokedDirectly = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) main();
