import { useEffect, useMemo, useState, type ReactNode } from "react";
import { parseMarkdownDocument, safeMarkdownLanguage, type MarkdownBlock } from "@/modules/editor/markdown-reader";
import type { ValidatedTimelinePayload } from "@/modules/agent-events/payload-resource";
import { useT } from "@/modules/i18n";
import { buildMiniDiffRows } from "./lib/diff-parse";

export const TIMELINE_RICH_MAX_TEXT_BYTES = 256 * 1024;
export const TIMELINE_RICH_MAX_LINES = 2_000;
export const TIMELINE_RICH_MAX_DOM_ROWS = 600;
export const TIMELINE_IMAGE_MAX_DECODED_BYTES = 768 * 1024;
export const TIMELINE_IMAGE_MAX_DIMENSION = 4_096;
export const TIMELINE_IMAGE_MAX_PIXELS = 12_000_000;

interface BudgetedText { text: string; truncated: boolean; totalLines: number }

export function budgetTimelineText(source: string): BudgetedText {
  const lines = source.split("\n");
  let text = lines.slice(0, TIMELINE_RICH_MAX_LINES).join("\n");
  let truncated = lines.length > TIMELINE_RICH_MAX_LINES;
  const encoder = new TextEncoder();
  if (encoder.encode(text).byteLength > TIMELINE_RICH_MAX_TEXT_BYTES) {
    let low = 0;
    let high = text.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (encoder.encode(text.slice(0, middle)).byteLength <= TIMELINE_RICH_MAX_TEXT_BYTES) low = middle;
      else high = middle - 1;
    }
    text = text.slice(0, low);
    truncated = true;
  }
  return { text, truncated, totalLines: lines.length };
}

interface CodeToken { kind: "plain" | "keyword" | "string" | "number" | "comment"; text: string }
const CODE_TOKEN = /(\/\/.*$|#.*$|\b(?:const|let|var|function|class|interface|type|return|if|else|for|while|async|await|import|export|from|fn|pub|impl|struct|enum|match|use|mod|def|None|True|False|null|true|false)\b|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b)/gm;

export function tokenizeTimelineCode(line: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  let cursor = 0;
  for (const match of line.matchAll(CODE_TOKEN)) {
    const index = match.index ?? 0;
    if (index > cursor) tokens.push({ kind: "plain", text: line.slice(cursor, index) });
    const text = match[0];
    const kind = text.startsWith("//") || text.startsWith("#") ? "comment"
      : /^["'`]/.test(text) ? "string"
        : /^\d/.test(text) ? "number" : "keyword";
    tokens.push({ kind, text });
    cursor = index + text.length;
  }
  if (cursor < line.length) tokens.push({ kind: "plain", text: line.slice(cursor) });
  return tokens.length > 0 ? tokens : [{ kind: "plain", text: line }];
}

function CodeLines({ text, className, maxLines = TIMELINE_RICH_MAX_DOM_ROWS }: { text: string; className?: string; maxLines?: number }) {
  const lines = text.split("\n").slice(0, Math.max(0, maxLines));
  return <code className={className}>{lines.map((line, lineIndex) => <span className="agent-timeline-code-line" key={lineIndex}>{tokenizeTimelineCode(line).map((token, tokenIndex) => <span data-token={token.kind} key={tokenIndex}>{token.text}</span>)}{lineIndex < lines.length - 1 ? "\n" : null}</span>)}</code>;
}

function InlineMarkdown({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|!??\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|\*[^*]+\*)/g).filter(Boolean);
  return <>{parts.map((part, index) => {
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    const image = part.match(/^!\[([^\]]*)\]\([^)]+\)$/);
    if (image) return <span className="agent-timeline-remote-omitted" key={index}>[{image[1] || "image"}]</span>;
    const link = part.match(/^\[([^\]]+)\]\([^)]+\)$/);
    if (link) return <span className="agent-timeline-link-label" key={index}>{link[1]}</span>;
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("*") && part.endsWith("*")) return <em key={index}>{part.slice(1, -1)}</em>;
    return <span key={index}>{part}</span>;
  })}</>;
}

function MarkdownBlockView({ block, maxRows = TIMELINE_RICH_MAX_DOM_ROWS }: { block: MarkdownBlock; maxRows?: number }): ReactNode {
  switch (block.type) {
    case "heading": {
      const content = <InlineMarkdown text={block.text} />;
      if (block.level === 1) return <h3>{content}</h3>;
      if (block.level === 2) return <h4>{content}</h4>;
      return <h5>{content}</h5>;
    }
    case "paragraph": return <p><InlineMarkdown text={block.text} /></p>;
    case "code": {
      const language = safeMarkdownLanguage(block.language);
      return <figure className="agent-timeline-code"><figcaption>{language?.label ?? "code"}</figcaption><pre tabIndex={0}><CodeLines text={block.text} className={language?.className} maxLines={maxRows} /></pre></figure>;
    }
    case "quote": return <blockquote><InlineMarkdown text={block.text} /></blockquote>;
    case "unordered-list": return <ul>{block.items.slice(0, maxRows).map((item, index) => <li key={index}><InlineMarkdown text={item} /></li>)}</ul>;
    case "ordered-list": return <ol>{block.items.slice(0, maxRows).map((item, index) => <li key={index}><InlineMarkdown text={item} /></li>)}</ol>;
    case "table": return <div className="agent-timeline-table-scroll" role="region" tabIndex={0}><table><thead><tr>{block.header.map((cell, index) => <th key={index}><InlineMarkdown text={cell} /></th>)}</tr></thead><tbody>{block.rows.slice(0, Math.max(0, maxRows - 1)).map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}><InlineMarkdown text={cell} /></td>)}</tr>)}</tbody></table></div>;
    case "mdx-source": return <figure className="agent-timeline-code"><figcaption>{`MDX ${block.kind}, not executed`}</figcaption><pre tabIndex={0}><CodeLines text={block.text} maxLines={maxRows} /></pre></figure>;
    case "rule": return <hr />;
  }
}

function TruncatedNotice({ budget }: { budget: BudgetedText }) {
  return budget.truncated ? <div className="agent-timeline-rich-truncated" role="note">Limited preview, {budget.totalLines.toLocaleString()} lines in payload</div> : null;
}

function TextPayload({ payload }: { payload: ValidatedTimelinePayload }) {
  const budget = useMemo(() => budgetTimelineText(payload.body), [payload.body]);
  let text = budget.text;
  if (payload.contentType === "application/json") {
    try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* fail safely to bounded plain text */ }
  }
  const rendered = budgetTimelineText(text);
  return <><pre className="agent-timeline-rich-pre" tabIndex={0}><CodeLines text={rendered.text} /></pre><TruncatedNotice budget={{ ...rendered, truncated: budget.truncated || rendered.truncated }} /></>;
}

function MarkdownPayload({ payload }: { payload: ValidatedTimelinePayload }) {
  const budget = useMemo(() => budgetTimelineText(payload.body), [payload.body]);
  const document = useMemo(() => parseMarkdownDocument(budget.text), [budget.text]);
  let remaining = TIMELINE_RICH_MAX_DOM_ROWS;
  const blocks: Array<{ block: MarkdownBlock; rows: number }> = [];
  for (const block of document.blocks) {
    if (remaining <= 0) break;
    const desired = block.type === "code" || block.type === "mdx-source" ? block.text.split("\n").length
      : block.type === "table" ? block.rows.length + 1
        : block.type === "unordered-list" || block.type === "ordered-list" ? block.items.length : 1;
    const rows = Math.min(remaining, Math.max(1, desired));
    blocks.push({ block, rows });
    remaining -= rows;
  }
  return <><div className="agent-timeline-markdown">{blocks.map(({ block, rows }) => <div key={block.key}>{MarkdownBlockView({ block, maxRows: rows })}</div>)}</div><TruncatedNotice budget={{ ...budget, truncated: budget.truncated || blocks.length < document.blocks.length }} /></>;
}

function DiffPayload({ payload }: { payload: ValidatedTimelinePayload }) {
  const budget = useMemo(() => budgetTimelineText(payload.body), [payload.body]);
  const allRows = useMemo(() => buildMiniDiffRows(budget.text), [budget.text]);
  const rows = allRows.slice(0, TIMELINE_RICH_MAX_DOM_ROWS);
  return <><pre className="agent-timeline-diff" tabIndex={0}>{rows.map((row) => <span key={row.key} data-diff={row.isAdd ? "add" : row.isDel ? "delete" : row.isHunk ? "hunk" : "context"}>{row.line}{"\n"}</span>)}</pre><TruncatedNotice budget={{ ...budget, truncated: budget.truncated || rows.length < allRows.length }} /></>;
}

function decodeStrictBase64(value: string): Uint8Array {
  if (!value || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error("invalidBase64");
  const binary = atob(value);
  if (binary.length > TIMELINE_IMAGE_MAX_DECODED_BYTES) throw new Error("imageTooLarge");
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function hasExpectedMagic(bytes: Uint8Array, type: string): boolean {
  if (type === "image/png") return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  if (type === "image/jpeg") return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === "image/webp") return bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
  return false;
}

function ImagePayload({ payload }: { payload: ValidatedTimelinePayload }) {
  const t = useT();
  const [state, setState] = useState<{ url: string; width: number; height: number } | { error: true } | null>(null);
  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    void (async () => {
      try {
        const bytes = decodeStrictBase64(payload.body);
        if (!hasExpectedMagic(bytes, payload.contentType)) throw new Error("imageTypeMismatch");
        const blob = new Blob([new Uint8Array(bytes).buffer], { type: payload.contentType });
        objectUrl = URL.createObjectURL(blob);
        const image = new Image();
        image.decoding = "async";
        image.src = objectUrl;
        await image.decode();
        const width = image.naturalWidth;
        const height = image.naturalHeight;
        if (width < 1 || height < 1 || width > TIMELINE_IMAGE_MAX_DIMENSION || height > TIMELINE_IMAGE_MAX_DIMENSION || width * height > TIMELINE_IMAGE_MAX_PIXELS) throw new Error("imageDimensionsExceeded");
        if (cancelled) return;
        setState({ url: objectUrl, width, height });
      } catch {
        if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
        if (!cancelled) setState({ error: true });
      }
    })();
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [payload]);
  if (!state) return <div className="agent-timeline-rich-placeholder">{t("timeline.rich.image_decoding")}</div>;
  if ("error" in state) return <div className="agent-timeline-rich-placeholder" role="status">{t("timeline.rich.image_invalid")}</div>;
  return <img className="agent-timeline-rich-image" src={state.url} width={state.width} height={state.height} alt={t("timeline.rich.image_alt")} />;
}

export function AgentTimelineRichRenderer({ payload }: { payload: ValidatedTimelinePayload }) {
  if (payload.contentType === "text/markdown") return <MarkdownPayload payload={payload} />;
  if (payload.contentType === "text/x-diff") return <DiffPayload payload={payload} />;
  if (payload.contentType.startsWith("image/")) return <ImagePayload payload={payload} />;
  return <TextPayload payload={payload} />;
}
