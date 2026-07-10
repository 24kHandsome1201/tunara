import { useEffect, useMemo, useState } from "react";
import { fsReadFile, type ReadResult } from "@/modules/fs/fs-bridge";
import { sshReadFile } from "@/modules/ssh/remote-fs-bridge";
import { formatSize } from "./types";
import { CloseIcon } from "./shared";
import { useT } from "@/modules/i18n";

interface FilePreviewProps {
  filePath: string;
  fileName: string;
  onClose: () => void;
  /** Fill the inspector content area instead of rendering as an inline card. */
  fill?: boolean;
  /** 远程 SSH 会话的 PTY id；存在则经 SFTP 读取。 */
  remotePtyId?: number;
}

function MarkdownPreview({ content, fill = false }: { content: string; fill?: boolean }) {
  const blocks = useMemo(() => parseMarkdown(content), [content]);
  const keys = new UniqueKeyBuilder();
  return (
    <div
      style={{ padding: "12px 14px 24px", overflow: "auto", maxHeight: fill ? undefined : 240, flex: fill ? 1 : undefined, minHeight: fill ? 0 : undefined }}
      className="no-scrollbar scroll-fade-y"
    >
      {blocks.map((block) => (
        <MarkdownBlock key={blockKey(block, keys)} block={block} />
      ))}
    </div>
  );
}

type Block =
  | { type: "h1" | "h2" | "h3"; text: string }
  | { type: "p"; text: string }
  | { type: "code"; lang?: string; text: string }
  | { type: "quote"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "hr" };

class UniqueKeyBuilder {
  private counts = new Map<string, number>();

  make(base: string): string {
    const count = this.counts.get(base) ?? 0;
    this.counts.set(base, count + 1);
    return count === 0 ? base : `${base}:${count}`;
  }
}

function compactKeyText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 96);
}

function blockKey(block: Block, keys: UniqueKeyBuilder): string {
  if (block.type === "ul" || block.type === "ol") {
    return keys.make(`${block.type}:${block.items.map(compactKeyText).join("|")}`);
  }
  if (block.type === "hr") return keys.make("hr");
  return keys.make(`${block.type}:${compactKeyText(block.text)}`);
}

function parseMarkdown(src: string): Block[] {
  const lines = src.split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("```")) {
      const lang = line.slice(3).trim() || undefined;
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: "code", lang, text: codeLines.join("\n") });
      i++;
      continue;
    }

    if (line.startsWith("### ")) {
      blocks.push({ type: "h3", text: line.slice(4) });
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      blocks.push({ type: "h2", text: line.slice(3) });
      i++;
      continue;
    }
    if (line.startsWith("# ")) {
      blocks.push({ type: "h1", text: line.slice(2) });
      i++;
      continue;
    }

    if (/^---+$/.test(line.trim()) || /^\*\*\*+$/.test(line.trim())) {
      blocks.push({ type: "hr" });
      i++;
      continue;
    }

    if (line.startsWith("> ")) {
      const quoteLines: string[] = [line.slice(2)];
      i++;
      while (i < lines.length && lines[i].startsWith("> ")) {
        quoteLines.push(lines[i].slice(2));
        i++;
      }
      blocks.push({ type: "quote", text: quoteLines.join("\n") });
      continue;
    }

    if (/^\s*[-*]\s/.test(line)) {
      const items: string[] = [line.replace(/^\s*[-*]\s/, "")];
      i++;
      while (i < lines.length && /^\s*[-*]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s/, ""));
        i++;
      }
      blocks.push({ type: "ul", items });
      continue;
    }

    if (/^\s*\d+\.\s/.test(line)) {
      const items: string[] = [line.replace(/^\s*\d+\.\s/, "")];
      i++;
      while (i < lines.length && /^\s*\d+\.\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s/, ""));
        i++;
      }
      blocks.push({ type: "ol", items });
      continue;
    }

    if (line.trim() === "") {
      i++;
      continue;
    }

    const paraLines: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !lines[i].startsWith("#") && !lines[i].startsWith("```") && !lines[i].startsWith("> ") && !/^\s*[-*]\s/.test(lines[i]) && !/^\s*\d+\.\s/.test(lines[i]) && !/^---+$/.test(lines[i].trim())) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ type: "p", text: paraLines.join(" ") });
  }

  return blocks;
}

function InlineText({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/);
  const keys = new UniqueKeyBuilder();
  return (
    <>
      {parts.map((part) => {
        const key = keys.make(`part:${compactKeyText(part)}`);
        if (part.startsWith("`") && part.endsWith("`")) {
          return (
            <code key={key} style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-meta)", background: "var(--c-bg-3)", borderRadius: 3, padding: "0 3px", color: "var(--c-accent)" }}>
              {part.slice(1, -1)}
            </code>
          );
        }
        if (part.startsWith("**") && part.endsWith("**")) {
          return <strong key={key} style={{ fontWeight: 600, color: "var(--c-text-2)" }}>{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith("*") && part.endsWith("*")) {
          return <em key={key} style={{ color: "var(--c-text-4)" }}>{part.slice(1, -1)}</em>;
        }
        const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (linkMatch) {
          return <span key={key} style={{ color: "var(--c-accent)" }}>{linkMatch[1]}</span>;
        }
        return <span key={key}>{part}</span>;
      })}
    </>
  );
}

function MarkdownBlock({ block }: { block: Block }) {
  switch (block.type) {
    case "h1":
      return <div style={{ fontSize: "var(--fs-body)", fontWeight: 700, color: "var(--c-text-primary)", margin: "0 0 6px", paddingBottom: 4, borderBottom: "1px solid var(--c-border-2)" }}><InlineText text={block.text} /></div>;
    case "h2":
      return <div style={{ fontSize: "var(--fs-secondary)", fontWeight: 600, color: "var(--c-text-2)", margin: "6px 0 4px" }}><InlineText text={block.text} /></div>;
    case "h3":
      return <div style={{ fontSize: "var(--fs-meta)", fontWeight: 600, color: "var(--c-text-4)", margin: "4px 0 2px" }}><InlineText text={block.text} /></div>;
    case "p":
      return <div style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-3)", lineHeight: 1.6, margin: "0 0 6px" }}><InlineText text={block.text} /></div>;
    case "code":
      return (
        <pre style={{ background: "var(--c-bg-3)", borderRadius: "var(--r-btn)", padding: "8px 10px", overflowX: "auto", margin: "4px 0" }}>
          <code style={{ fontSize: "var(--fs-meta)", fontFamily: "var(--font-mono)", color: "var(--c-text-2)" }}>{block.text}</code>
        </pre>
      );
    case "quote":
      return <div style={{ borderTop: "1px solid var(--c-border-1)", borderBottom: "1px solid var(--c-border-1)", background: "var(--c-bg-1)", padding: "7px 8px", color: "var(--c-text-4)", margin: "6px 0", fontSize: "var(--fs-meta)", lineHeight: 1.65 }}><InlineText text={block.text} /></div>;
    case "ul": {
      const ulKeys = new UniqueKeyBuilder();
      return (
        <ul style={{ paddingLeft: 16, margin: "4px 0", listStyle: "disc" }}>
          {block.items.map((item) => <li key={ulKeys.make(`ul:${compactKeyText(item)}`)} style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-3)", lineHeight: 1.6 }}><InlineText text={item} /></li>)}
        </ul>
      );
    }
    case "ol": {
      const olKeys = new UniqueKeyBuilder();
      return (
        <ol style={{ paddingLeft: 16, margin: "4px 0" }}>
          {block.items.map((item) => <li key={olKeys.make(`ol:${compactKeyText(item)}`)} style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-3)", lineHeight: 1.6 }}><InlineText text={item} /></li>)}
        </ol>
      );
    }
    case "hr":
      return <div style={{ borderTop: "1px solid var(--c-border-2)", margin: "8px 0" }} />;
  }
}

function TextPreview({ content, fill = false }: { content: string; fill?: boolean }) {
  return (
    <div
      style={{ padding: "12px 14px 24px", overflow: "auto", maxHeight: fill ? undefined : 240, flex: fill ? 1 : undefined, minHeight: fill ? 0 : undefined }}
      className="no-scrollbar scroll-fade-y"
    >
      <pre style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-meta)", color: "var(--c-text-3)", lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-all", margin: 0 }}>
        {content}
      </pre>
    </div>
  );
}

function PreviewMessage({ icon, text }: { icon: string; text: string }) {
  return (
    <div style={{ padding: 12, display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontSize: 14, color: "var(--c-text-6)", flexShrink: 0 }}>{icon}</span>
      <span style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-5)" }}>{text}</span>
    </div>
  );
}

export function FilePreview({ filePath, fileName, onClose, fill = false, remotePtyId }: FilePreviewProps) {
  const t = useT();
  const [result, setResult] = useState<ReadResult | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setError(false);
    const read =
      remotePtyId !== undefined ? sshReadFile(remotePtyId, filePath) : fsReadFile(filePath);
    read
      .then((r) => { if (!cancelled) setResult(r); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [filePath, remotePtyId]);

  const isMarkdown = /\.md$/i.test(fileName);
  const textContent = result?.kind === "text"
    ? result.content + (result.truncated ? `\n${t("preview.truncated")}` : "")
    : "";

  return (
    <div
      style={{
        background: "var(--c-bg-white)",
        border: fill ? "none" : "1px solid var(--c-border-2)",
        borderRadius: fill ? 0 : "var(--r-btn)",
        marginTop: fill ? 0 : 2,
        overflow: "hidden",
        height: fill ? "100%" : undefined,
        minHeight: fill ? 0 : undefined,
        display: fill ? "flex" : undefined,
        flexDirection: fill ? "column" : undefined,
      }}
    >
      <div style={{ height: fill ? 40 : 34, borderBottom: "1px solid var(--c-border-1)", background: fill ? "var(--c-bg-1)" : "transparent", display: "flex", alignItems: "center", gap: 8, padding: fill ? "0 12px" : "0 10px", flexShrink: 0 }}>
        {fill && (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--c-text-5)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
            <path d="M14 2v6h6" />
          </svg>
        )}
        <span style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-primary)", fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)" }}>{fileName}</span>
        <button
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          className="hover-bg"
          title={t("common.close")}
          aria-label={t("common.close")}
          style={{ width: fill ? 26 : 22, height: fill ? 26 : 22, borderRadius: "var(--r-btn)", border: "none", background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
        >
          <CloseIcon size={11} strokeWidth={2.5} />
        </button>
      </div>

      {error ? (
        <PreviewMessage icon="⊘" text={t("preview.read_failed")} />
      ) : !result ? (
        <div style={{ padding: "12px 14px", display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--c-text-5)", animation: "loadPulse 1.2s var(--ease-in-out) infinite", flexShrink: 0 }} />
          <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)" }}>{t("preview.reading")}</span>
        </div>
      ) : result.kind === "binary" ? (
        <PreviewMessage icon="⊘" text={t("preview.binary", { size: formatSize(result.size) })} />
      ) : result.kind === "toolarge" ? (
        <PreviewMessage icon="⊘" text={t("preview.too_large", { size: formatSize(result.size) })} />
      ) : isMarkdown ? (
        <MarkdownPreview content={textContent} fill={fill} />
      ) : (
        <TextPreview content={textContent} fill={fill} />
      )}
    </div>
  );
}
