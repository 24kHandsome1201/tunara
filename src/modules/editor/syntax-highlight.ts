import { detectLanguage, type DetectedLanguage } from "./language-detect.ts";
import { highlightLogSource, type LogSyntaxSegment } from "./log-syntax.ts";
import { highlightMarkdownSource, type MarkdownSyntaxSegment } from "./markdown-syntax.ts";
import type { CodeSyntaxSegment } from "./shiki-highlight.ts";

export type SyntaxSegment = MarkdownSyntaxSegment | LogSyntaxSegment | CodeSyntaxSegment;

export const SHIKI_MAX_BYTES = 400 * 1024;
export const SHIKI_MAX_LINES = 8_000;
export const LOG_MAX_CHARS = 2_000_000;
export const OVERLAY_MAX_LINES = 8_000;
export const DIFF_HIGHLIGHT_MAX_LINES = 2_000;

export function countSourceLines(content: string): number {
  if (content.length === 0) return 1;
  let lines = 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

function exceedsShikiBudget(content: string): boolean {
  return content.length > SHIKI_MAX_BYTES || countSourceLines(content) > SHIKI_MAX_LINES;
}

async function highlightCode(language: Exclude<DetectedLanguage, "markdown" | "log">, content: string): Promise<SyntaxSegment[][] | null> {
  if (exceedsShikiBudget(content)) return null;
  const { highlightWithShiki } = await import("./shiki-highlight.ts");
  return highlightWithShiki(language, content);
}

/**
 * One highlight pipeline for the reader overlay, read-only preview, and diff rows.
 * Returns null when the file should stay uncolored (unknown language or over budget).
 *
 * Markdown stays on the existing line-local highlighter: it is sync, cheap, and
 * emits editor-specific kinds (heading / marker / link / value) that Shiki would
 * flatten into generic code tokens.
 */
export async function highlightSource(fileName: string, content: string): Promise<SyntaxSegment[][] | null> {
  const language = detectLanguage(fileName, content);
  if (!language) return null;
  if (language === "markdown") {
    if (countSourceLines(content) > SHIKI_MAX_LINES) return null;
    return highlightMarkdownSource(content);
  }
  if (language === "log") {
    if (content.length > LOG_MAX_CHARS) return null;
    return highlightLogSource(content);
  }
  try {
    return await highlightCode(language, content);
  } catch {
    return null;
  }
}

/**
 * Highlight reconstructed diff bodies (one source line per row, already stripped
 * of the leading +/-/space marker). Skips when the language is unknown or the
 * row count is at or above 2 000.
 */
export async function highlightDiffBodies(
  fileName: string,
  bodies: readonly string[],
): Promise<SyntaxSegment[][] | null> {
  if (bodies.length === 0 || bodies.length >= DIFF_HIGHLIGHT_MAX_LINES) return null;
  return highlightSource(fileName, bodies.join("\n"));
}
