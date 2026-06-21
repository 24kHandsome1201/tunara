import { useEffect, useMemo, useState } from "react";
import { fsReadFile, type ReadResult } from "@/modules/fs/fs-bridge";
import { formatSize } from "./types";

interface FilePreviewProps {
  filePath: string;
  fileName: string;
  onClose: () => void;
}

function MarkdownPreview({ content }: { content: string }) {
  const blocks = useMemo(() => parseMarkdown(content), [content]);
  return (
    <div style={{ padding: "10px 12px", overflow: "auto", maxHeight: 240 }} className="no-scrollbar">
      {blocks.map((block, i) => (
        <MarkdownBlock key={i} block={block} />
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
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("`") && part.endsWith("`")) {
          return (
            <code key={i} style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-meta)", background: "var(--c-bg-3)", borderRadius: 3, padding: "0 3px", color: "var(--c-accent)" }}>
              {part.slice(1, -1)}
            </code>
          );
        }
        if (part.startsWith("**") && part.endsWith("**")) {
          return <strong key={i} style={{ fontWeight: 600, color: "var(--c-text-2)" }}>{part.slice(2, -2)}</strong>;
        }
        if (part.startsWith("*") && part.endsWith("*")) {
          return <em key={i} style={{ color: "var(--c-text-4)" }}>{part.slice(1, -1)}</em>;
        }
        const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (linkMatch) {
          return <span key={i} style={{ color: "var(--c-accent)" }}>{linkMatch[1]}</span>;
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

function MarkdownBlock({ block }: { block: Block }) {
  switch (block.type) {
    case "h1":
      return <div style={{ fontSize: 13, fontWeight: 700, color: "var(--c-text-primary)", margin: "0 0 6px", paddingBottom: 4, borderBottom: "1px solid var(--c-border-2)" }}><InlineText text={block.text} /></div>;
    case "h2":
      return <div style={{ fontSize: 12, fontWeight: 600, color: "var(--c-text-2)", margin: "6px 0 4px" }}><InlineText text={block.text} /></div>;
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
      return <div style={{ borderLeft: "2px solid var(--c-border-2)", paddingLeft: 8, color: "var(--c-text-5)", margin: "4px 0", fontSize: "var(--fs-meta)", lineHeight: 1.6 }}><InlineText text={block.text} /></div>;
    case "ul":
      return (
        <ul style={{ paddingLeft: 16, margin: "4px 0", listStyle: "disc" }}>
          {block.items.map((item, i) => <li key={i} style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-3)", lineHeight: 1.6 }}><InlineText text={item} /></li>)}
        </ul>
      );
    case "ol":
      return (
        <ol style={{ paddingLeft: 16, margin: "4px 0" }}>
          {block.items.map((item, i) => <li key={i} style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-3)", lineHeight: 1.6 }}><InlineText text={item} /></li>)}
        </ol>
      );
    case "hr":
      return <div style={{ borderTop: "1px solid var(--c-border-2)", margin: "8px 0" }} />;
  }
}

function TextPreview({ content }: { content: string }) {
  return (
    <div style={{ padding: "10px 12px", overflow: "auto", maxHeight: 240 }} className="no-scrollbar">
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

export function FilePreview({ filePath, fileName, onClose }: FilePreviewProps) {
  const [result, setResult] = useState<ReadResult | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setError(false);
    fsReadFile(filePath)
      .then((r) => { if (!cancelled) setResult(r); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [filePath]);

  const isMarkdown = /\.md$/i.test(fileName);
  const textContent = result?.kind === "text"
    ? result.content + (result.truncated ? "\n… 已截断" : "")
    : "";

  return (
    <div style={{ background: "var(--c-bg-white)", border: "1px solid var(--c-border-2)", borderRadius: "var(--r-btn)", marginTop: 2, overflow: "hidden" }}>
      <div style={{ height: 34, borderBottom: "1px solid var(--c-border-2)", display: "flex", alignItems: "center", padding: "0 10px", flexShrink: 0 }}>
        <span style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-2)", fontWeight: 500, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)" }}>{fileName}</span>
        <button
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          className="hover-bg"
          style={{ width: 22, height: 22, borderRadius: "var(--r-btn)", border: "none", background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {error ? (
        <PreviewMessage icon="⊘" text="读取失败" />
      ) : !result ? (
        <div style={{ padding: "12px 14px", display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--c-text-5)", animation: "pulseDot 1.2s ease infinite", flexShrink: 0 }} />
          <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)" }}>读取中…</span>
        </div>
      ) : result.kind === "binary" ? (
        <PreviewMessage icon="⊘" text={`二进制文件（${formatSize(result.size)}）`} />
      ) : result.kind === "toolarge" ? (
        <PreviewMessage icon="⊘" text={`文件过大（${formatSize(result.size)}）`} />
      ) : isMarkdown ? (
        <MarkdownPreview content={textContent} />
      ) : (
        <TextPreview content={textContent} />
      )}
    </div>
  );
}
