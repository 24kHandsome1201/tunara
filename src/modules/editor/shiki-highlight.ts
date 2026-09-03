import type { HighlighterCore } from "shiki/core";
import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import type { ShikiLanguage } from "./language-detect.ts";
import { kindFromScopes, type CodeSyntaxKind } from "./syntax-scopes.ts";

export interface CodeSyntaxSegment {
  kind: CodeSyntaxKind | "text";
  text: string;
}

const SCOPE_THEME = {
  name: "tunara-scopes",
  type: "dark" as const,
  bg: "#000000",
  fg: "#ffffff",
  settings: [
    { scope: "comment", settings: { foreground: "#010101" } },
    { scope: "string", settings: { foreground: "#020202" } },
    { scope: "constant.numeric", settings: { foreground: "#030303" } },
    { scope: "constant.language", settings: { foreground: "#040404" } },
    { scope: "keyword", settings: { foreground: "#050505" } },
    { scope: "storage", settings: { foreground: "#060606" } },
    { scope: "entity.name.function", settings: { foreground: "#070707" } },
    { scope: "support.function", settings: { foreground: "#080808" } },
    { scope: "entity.name.type", settings: { foreground: "#090909" } },
    { scope: "support.type", settings: { foreground: "#0a0a0a" } },
    { scope: "variable", settings: { foreground: "#0b0b0b" } },
    { scope: "entity.name.tag", settings: { foreground: "#0c0c0c" } },
    { scope: "entity.other.attribute-name", settings: { foreground: "#0d0d0d" } },
    { scope: "punctuation", settings: { foreground: "#0e0e0e" } },
    { scope: "keyword.operator", settings: { foreground: "#0f0f0f" } },
    { scope: "support.type.property-name", settings: { foreground: "#101010" } },
    { scope: "meta.object-literal.key", settings: { foreground: "#111111" } },
  ],
};

const GRAMMAR_LOADERS: Record<ShikiLanguage, () => Promise<{ default: unknown }>> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  dockerfile: () => import("shiki/langs/dockerfile.mjs"),
};

const GRAMMAR_DEPENDENCIES: Partial<Record<ShikiLanguage, ShikiLanguage[]>> = {
  tsx: ["typescript"],
  jsx: ["javascript"],
};

let highlighterPromise: Promise<HighlighterCore> | null = null;
const loadedLanguages = new Set<ShikiLanguage>();
const loadingLanguages = new Map<ShikiLanguage, Promise<void>>();

function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    engine: createJavaScriptRegexEngine({ forgiving: true }),
    langs: [],
    themes: [SCOPE_THEME],
  });
  return highlighterPromise;
}

async function loadLanguage(language: ShikiLanguage): Promise<void> {
  if (loadedLanguages.has(language)) return;
  const pending = loadingLanguages.get(language);
  if (pending) {
    await pending;
    return;
  }
  const task = (async () => {
    for (const dependency of GRAMMAR_DEPENDENCIES[language] ?? []) {
      await loadLanguage(dependency);
    }
    const highlighter = await getHighlighter();
    const mod = await GRAMMAR_LOADERS[language]();
    await highlighter.loadLanguage(mod.default as never);
    loadedLanguages.add(language);
    loadingLanguages.delete(language);
  })();
  loadingLanguages.set(language, task);
  await task;
}

function scopesOfToken(explanation: Array<{ scopes: Array<{ scopeName: string }> }> | undefined): string[] {
  if (!explanation || explanation.length === 0) return [];
  // The last explanation chunk is the token itself; its scope stack is root → specific.
  const scopes = explanation[explanation.length - 1]?.scopes ?? explanation[0]?.scopes ?? [];
  return scopes.map((scope) => scope.scopeName);
}

function mergeSegments(segments: CodeSyntaxSegment[]): CodeSyntaxSegment[] {
  if (segments.length === 0) return [{ kind: "text", text: "" }];
  const merged: CodeSyntaxSegment[] = [];
  for (const segment of segments) {
    const last = merged[merged.length - 1];
    if (last && last.kind === segment.kind) last.text += segment.text;
    else merged.push({ kind: segment.kind, text: segment.text });
  }
  return merged;
}

export async function highlightWithShiki(language: ShikiLanguage, content: string): Promise<CodeSyntaxSegment[][]> {
  await loadLanguage(language);
  const highlighter = await getHighlighter();
  const result = highlighter.codeToTokens(content, {
    lang: language,
    theme: "tunara-scopes",
    includeExplanation: "scopeName",
    tokenizeMaxLineLength: 2_000,
    tokenizeTimeLimit: 200,
  });
  return result.tokens.map((line) => {
    if (line.length === 0) return [{ kind: "text" as const, text: "" }];
    return mergeSegments(line.map((token) => ({
      kind: kindFromScopes(scopesOfToken(token.explanation)),
      text: token.content,
    })));
  });
}
