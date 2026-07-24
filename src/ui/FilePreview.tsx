import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { fsReadFile, fsWriteTextFile, type ReadResult } from "@/modules/fs/fs-bridge";
import {
  sshReadFile,
  sshReconcileOutcomeUnknownTextWrite,
  sshWriteTextFile,
} from "@/modules/ssh/remote-fs-bridge";
import {
  parseSshWriteOutcomeUnknown,
  type SshWriteOutcomeUnknown,
} from "@/modules/ssh/ssh-write-reconcile";
import { formatSize } from "./types";
import { CloseIcon } from "./shared";
import { useT, t as staticT } from "@/modules/i18n";
import { useUIStore } from "@/state/ui";
import { openInEditorWithToast } from "./lib/open-in-editor";
import { copyText } from "./lib/clipboard";
import { useSessionsStore } from "@/state/sessions";
import {
  cancelDirtyDraftAction,
  confirmDirtyDraftDiscard,
  hasPendingDirtyDraftAction,
  registerDirtyDraft,
  updateDirtyDraft,
} from "@/modules/editor/dirty-draft-guard";
import { parseMarkdownDocument, safeMarkdownLanguage, type MarkdownBlock as MarkdownReaderBlock } from "@/modules/editor/markdown-reader";
import { highlightMarkdownSource } from "@/modules/editor/markdown-syntax";
import {
  discardEditorDraft,
  editorDraftKey,
  readEditorDraft,
  retainEditorDraft,
  type EditorDraftSaveState,
} from "@/modules/editor/editor-draft-registry";
import { normalizedScrollPosition, scrollTopForPosition } from "@/modules/editor/scroll-position";
import { classifyFileOperationError, type FileOperationErrorKind } from "@/modules/editor/file-operation-error";
import { parseNotebook, type NotebookCell } from "@/modules/editor/notebook";

/** 值防抖：delayMs 内连续变化只取最后一个，用于高开销派生的计算闸门。 */
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

interface FilePreviewProps {
  sessionId?: string;
  filePath: string;
  fileName: string;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onNeedsAttention?: () => void;
  /** Fill the inspector content area instead of rendering as an inline card. */
  fill?: boolean;
  /** 远程 SSH 会话的 PTY id；存在则经 SFTP 读取。 */
  remotePtyId?: number;
  /** Stable transport identity; remains true while an SSH PTY is disconnected. */
  remote?: boolean;
}

interface MarkdownFindCursor {
  current: number;
  active: number;
}

function HighlightedText({ text, query, cursor }: { text: string; query: string; cursor: MarkdownFindCursor }) {
  if (!query) return text;
  const parts: React.ReactNode[] = [];
  const haystack = text.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  let offset = 0;
  while (offset <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) break;
    if (index > offset) parts.push(text.slice(offset, index));
    const matchIndex = cursor.current++;
    const active = matchIndex === cursor.active;
    parts.push(
      <mark key={`${matchIndex}:${index}`} className="markdown-find-match" data-markdown-find-index={matchIndex} data-active={active} aria-current={active ? "true" : undefined}>
        {text.slice(index, index + query.length)}
      </mark>,
    );
    offset = index + Math.max(query.length, 1);
  }
  if (offset < text.length) parts.push(text.slice(offset));
  return parts.length > 0 ? parts : text;
}

function MarkdownPreview({ content, fill = false, findQuery = "", activeFindIndex = -1, initialScrollRatio = 0, onMatchCountChange, onScrollRatioChange }: { content: string; fill?: boolean; findQuery?: string; activeFindIndex?: number; initialScrollRatio?: number; onMatchCountChange?: (count: number) => void; onScrollRatioChange?: (ratio: number) => void }) {  const t = useT();
  const document = useMemo(() => parseMarkdownDocument(content), [content]);
  const previewRef = useRef<HTMLDivElement>(null);
  const matchCursor: MarkdownFindCursor = { current: 0, active: activeFindIndex };
  useLayoutEffect(() => {
    const root = previewRef.current;
    if (!root) return;
    root.scrollTop = scrollTopForPosition(initialScrollRatio, root.scrollHeight, root.clientHeight);
  }, [initialScrollRatio]);
  useEffect(() => {
    const root = previewRef.current;
    if (!root) return;
    const marks = root.querySelectorAll<HTMLElement>("[data-markdown-find-index]");
    onMatchCountChange?.(marks.length);
    if (activeFindIndex < 0) return;
    marks.item(activeFindIndex)?.scrollIntoView({ block: "center", inline: "nearest" });
  }, [activeFindIndex, content, findQuery, onMatchCountChange]);
  return (
    <div
      ref={previewRef}
      onScroll={(event) => onScrollRatioChange?.(normalizedScrollPosition(event.currentTarget.scrollTop, event.currentTarget.scrollHeight, event.currentTarget.clientHeight))}
      style={{ padding: "12px 14px 24px", overflow: "auto", overflowWrap: "anywhere", maxHeight: fill ? undefined : 240, flex: fill ? 1 : undefined, minHeight: fill ? 0 : undefined }}
      className="no-scrollbar scroll-fade-y"
    >
      {document.toc.length > 0 && (
        <details open={document.toc.length <= 4} style={{ borderLeft: "2px solid var(--c-border-2)", padding: "2px 0 2px 10px", marginBottom: 16 }}>
          <summary style={{ color: "var(--c-text-4)", cursor: "pointer", fontSize: "var(--fs-secondary)", fontWeight: 650, lineHeight: 1.5 }}>
            {t("preview.markdown.toc_count", { count: document.toc.length })}
          </summary>
          <nav aria-label={t("preview.markdown.toc")} style={{ display: "flex", flexDirection: "column", gap: 4, paddingTop: 7, maxHeight: "min(35vh, 240px)", overflowY: "auto" }}>
            {document.toc.map((entry) => (
              <a key={entry.id} href={`#${entry.id}`} onClick={(event) => { event.preventDefault(); focusMarkdownAnchor(entry.id); }} style={{ color: "var(--c-text-3)", fontSize: "var(--fs-secondary)", lineHeight: 1.45, paddingLeft: (entry.level - 1) * 12, textDecoration: "none", whiteSpace: "normal", overflowWrap: "anywhere" }}>
                {entry.text}
              </a>
            ))}
          </nav>
        </details>
      )}
      {document.blocks.map((block) => (
        <MarkdownBlock key={block.key} block={block} findQuery={findQuery} matchCursor={matchCursor} />
      ))}
    </div>
  );
}

function focusMarkdownAnchor(id: string) {
  const target = document.getElementById(id);
  if (!target) return;
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  target.focus({ preventScroll: true });
}

function focusMarkdownHref(href: string) {
  try {
    focusMarkdownAnchor(decodeURIComponent(href.slice(1)));
  } catch {
    // A malformed percent escape is untrusted document text, not an app error.
  }
}

function InlineText({ text, findQuery = "", matchCursor }: { text: string; findQuery?: string; matchCursor?: MarkdownFindCursor }) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/);
  const cursor = matchCursor ?? { current: 0, active: -1 };
  return (
    <>
      {parts.map((part, index) => {
        const key = `${index}:${part.slice(0, 48)}`;
        if (part.startsWith("`") && part.endsWith("`")) {
          return (
            <code key={key} style={{ fontFamily: "var(--font-mono)", fontSize: "var(--fs-meta)", background: "var(--c-bg-3)", borderRadius: 3, padding: "0 3px", color: "var(--c-accent)" }}>
              <HighlightedText text={part.slice(1, -1)} query={findQuery} cursor={cursor} />
            </code>
          );
        }
        if (part.startsWith("**") && part.endsWith("**")) {
          return <strong key={key} style={{ fontWeight: 600, color: "var(--c-text-2)" }}><HighlightedText text={part.slice(2, -2)} query={findQuery} cursor={cursor} /></strong>;
        }
        if (part.startsWith("*") && part.endsWith("*")) {
          return <em key={key} style={{ color: "var(--c-text-4)" }}><HighlightedText text={part.slice(1, -1)} query={findQuery} cursor={cursor} /></em>;
        }
        const linkMatch = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (linkMatch) {
          const href = linkMatch[2].trim();
          if (href.startsWith("#")) {
            return <a key={key} href={href} onClick={(event) => { event.preventDefault(); focusMarkdownHref(href); }} style={{ color: "var(--c-accent)", textDecoration: "underline", textUnderlineOffset: 2 }}><HighlightedText text={linkMatch[1]} query={findQuery} cursor={cursor} /></a>;
          }
          if (/^https?:\/\//i.test(href)) {
            return <a key={key} href={href} target="_blank" rel="noreferrer noopener" style={{ color: "var(--c-accent)", textDecoration: "underline", textUnderlineOffset: 2 }}><HighlightedText text={linkMatch[1]} query={findQuery} cursor={cursor} /></a>;
          }
          return <span key={key}><HighlightedText text={linkMatch[1]} query={findQuery} cursor={cursor} /></span>;
        }
        return <span key={key}><HighlightedText text={part} query={findQuery} cursor={cursor} /></span>;
      })}
    </>
  );
}

function MarkdownBlock({ block, findQuery, matchCursor }: { block: MarkdownReaderBlock; findQuery: string; matchCursor: MarkdownFindCursor }) {
  switch (block.type) {
    case "heading": {
      const style = block.level === 1
        ? { fontSize: "var(--fs-reader-h1)", color: "var(--c-text-primary)", margin: "0 0 8px", paddingBottom: 5, borderBottom: "1px solid var(--c-border-2)" }
        : block.level === 2
          ? { fontSize: "var(--fs-reader-h2)", color: "var(--c-text-2)", margin: "14px 0 5px" }
          : { fontSize: "var(--fs-reader-h3)", color: "var(--c-text-4)", margin: "10px 0 3px" };
      const children = <InlineText text={block.text} findQuery={findQuery} matchCursor={matchCursor} />;
      if (block.level === 1) return <h1 id={block.id} tabIndex={-1} style={{ ...style, fontWeight: 700, scrollMarginTop: 12 }}>{children}</h1>;
      if (block.level === 2) return <h2 id={block.id} tabIndex={-1} style={{ ...style, fontWeight: 650, scrollMarginTop: 12 }}>{children}</h2>;
      return <h3 id={block.id} tabIndex={-1} style={{ ...style, fontWeight: 600, scrollMarginTop: 12 }}>{children}</h3>;
    }
    case "paragraph":
      return <div style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-3)", lineHeight: 1.65, margin: "0 0 7px" }}><InlineText text={block.text} findQuery={findQuery} matchCursor={matchCursor} /></div>;
    case "code": {
      const language = safeMarkdownLanguage(block.language);
      return (
        <figure aria-label={staticT("preview.markdown.code")} style={{ background: "var(--c-bg-3)", border: "1px solid var(--c-border-1)", borderRadius: "var(--r-card)", overflow: "hidden", margin: "7px 0 10px" }}>
          {language && <figcaption style={{ borderBottom: "1px solid var(--c-border-1)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)", fontSize: "var(--fs-meta-sm)", padding: "4px 9px", letterSpacing: "0.03em", overflowWrap: "anywhere" }}>{language.label}</figcaption>}
          <pre tabIndex={0} aria-label={staticT("preview.markdown.code")} style={{ padding: "9px 10px", overflowX: "auto", margin: 0 }}><code className={language?.className} style={{ fontSize: "var(--fs-secondary)", fontFamily: "var(--font-mono)", color: "var(--c-text-2)" }}><HighlightedText text={block.text} query={findQuery} cursor={matchCursor} /></code></pre>
        </figure>
      );
    }
    case "quote":
      return <div style={{ borderTop: "1px solid var(--c-border-1)", borderBottom: "1px solid var(--c-border-1)", background: "var(--c-bg-1)", padding: "7px 8px", color: "var(--c-text-4)", margin: "6px 0", fontSize: "var(--fs-secondary)", lineHeight: 1.65 }}><InlineText text={block.text} findQuery={findQuery} matchCursor={matchCursor} /></div>;
    case "unordered-list": {
      return (
        <ul style={{ paddingLeft: 16, margin: "4px 0", listStyle: "disc" }}>
          {block.items.map((item, index) => <li key={`${index}:${item}`} style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-3)", lineHeight: 1.65 }}><InlineText text={item} findQuery={findQuery} matchCursor={matchCursor} /></li>)}
        </ul>
      );
    }
    case "ordered-list": {
      return (
        <ol style={{ paddingLeft: 16, margin: "4px 0" }}>
          {block.items.map((item, index) => <li key={`${index}:${item}`} style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-3)", lineHeight: 1.65 }}><InlineText text={item} findQuery={findQuery} matchCursor={matchCursor} /></li>)}
        </ol>
      );
    }
    case "table":
      return (
        <div role="region" tabIndex={0} aria-label={staticT("preview.markdown.table")} style={{ overflowX: "auto", margin: "8px 0 12px", border: "1px solid var(--c-border-1)", borderRadius: "var(--r-card)" }}>
          <table style={{ width: "max-content", minWidth: "100%", borderCollapse: "collapse", fontSize: "var(--fs-secondary)", color: "var(--c-text-3)" }}>
            <thead><tr>{block.header.map((cell, column) => <th key={column} style={{ minWidth: 96, maxWidth: 280, background: "var(--c-bg-1)", borderBottom: "1px solid var(--c-border-2)", padding: "6px 8px", textAlign: block.alignments[column] ?? "left", fontWeight: 650 }}><InlineText text={cell} findQuery={findQuery} matchCursor={matchCursor} /></th>)}</tr></thead>
            <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, column) => <td key={column} style={{ minWidth: 96, maxWidth: 280, borderTop: rowIndex === 0 ? "none" : "1px solid var(--c-border-1)", padding: "6px 8px", textAlign: block.alignments[column] ?? "left" }}><InlineText text={cell} findQuery={findQuery} matchCursor={matchCursor} /></td>)}</tr>)}</tbody>
          </table>
        </div>
      );
    case "mdx-source": {
      const label = block.kind === "module"
        ? staticT("preview.markdown.mdx_module")
        : block.kind === "component"
          ? staticT("preview.markdown.mdx_component")
          : staticT("preview.markdown.mdx_expression");
      return (
        <figure aria-label={label} className="markdown-mdx-source">
          <figcaption>{label}</figcaption>
          <pre tabIndex={0} aria-label={label}><code><HighlightedText text={block.text} query={findQuery} cursor={matchCursor} /></code></pre>
        </figure>
      );
    }
    case "rule":
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

function NotebookMarkdownCell({ source }: { source: string }) {
  const document = useMemo(() => parseMarkdownDocument(source), [source]);
  const matchCursor: MarkdownFindCursor = { current: 0, active: -1 };
  return (
    <div className="notebook-markdown-cell">
      {document.blocks.map((block) => (
        <MarkdownBlock key={block.key} block={block} findQuery="" matchCursor={matchCursor} />
      ))}
    </div>
  );
}

function NotebookCellView({ cell, index }: { cell: NotebookCell; index: number }) {
  const t = useT();
  if (cell.kind === "markdown") {
    return (
      <article className="notebook-cell" data-cell-kind="markdown" aria-label={t("preview.notebook.markdown_cell", { index: index + 1 })}>
        <NotebookMarkdownCell source={cell.source} />
      </article>
    );
  }
  if (cell.kind === "raw") {
    return (
      <article className="notebook-cell" data-cell-kind="raw" aria-label={t("preview.notebook.raw_cell", { index: index + 1 })}>
        <div className="notebook-cell-gutter">{t("preview.notebook.raw_gutter")}</div>
        <pre className="notebook-cell-source"><code>{cell.source}</code></pre>
      </article>
    );
  }
  return (
    <article className="notebook-cell" data-cell-kind="code" aria-label={t("preview.notebook.code_cell", { index: index + 1 })}>
      <div className="notebook-cell-code">
        <div className="notebook-cell-gutter">{t("preview.notebook.in_gutter", { count: cell.executionCount ?? " " })}</div>
        <pre className="notebook-cell-source"><code>{cell.source}</code></pre>
      </div>
      {cell.outputs.length > 0 && (
        <div className="notebook-outputs">
          {cell.outputs.map((output, outputIndex) => {
            if (output.kind === "omitted") {
              return <div className="notebook-output-omitted" key={outputIndex}>{t("preview.notebook.rich_output_omitted")}</div>;
            }
            if (output.kind === "error") {
              const text = output.traceback.length > 0
                ? output.traceback.join("\n")
                : `${output.name}: ${output.value}`;
              return <pre className="notebook-output notebook-output-error" key={outputIndex}><code>{text}</code></pre>;
            }
            return <pre className="notebook-output" key={outputIndex}><code>{output.text}</code></pre>;
          })}
        </div>
      )}
    </article>
  );
}

function NotebookPreview({ content }: { content: string }) {
  const t = useT();
  const parsed = useMemo(() => parseNotebook(content), [content]);
  if (!parsed.ok) {
    return (
      <div className="notebook-invalid" role="alert">
        <strong>{t("preview.notebook.invalid")}</strong>
        <span>{t("preview.notebook.invalid_body")}</span>
        <code>{parsed.message}</code>
      </div>
    );
  }
  return (
    <div className="notebook-preview no-scrollbar">
      <div className="notebook-summary">
        <span>{t("preview.notebook.cells", { count: parsed.notebook.cells.length })}</span>
        <span>{parsed.notebook.language ?? `nbformat ${parsed.notebook.nbformat}`}</span>
        <span>{t("preview.notebook.safe_mode")}</span>
      </div>
      {parsed.notebook.cells.length > 0
        ? parsed.notebook.cells.map((cell, index) => <NotebookCellView key={index} cell={cell} index={index} />)
        : <div className="notebook-empty">{t("preview.notebook.empty")}</div>}
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

type SaveState = EditorDraftSaveState;
type OperationError = { operation: "save" | "reload"; kind: FileOperationErrorKind; detail: string };

function EditorSurface({
  sessionId,
  filePath,
  fileName,
  initialContent,
  initialFingerprint,
  remotePtyId,
  remote,
  isMarkdown,
  isNotebook,
  onClose,
  onDirtyChange,
  onNeedsAttention,
}: {
  sessionId: string | null;
  filePath: string;
  fileName: string;
  initialContent: string;
  initialFingerprint: string;
  remotePtyId?: number;
  remote?: boolean;
  isMarkdown: boolean;
  isNotebook: boolean;
  onClose: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  onNeedsAttention?: () => void;
}) {
  const t = useT();
  const isRemote = remote || remotePtyId !== undefined;
  const remoteDisconnected = isRemote && remotePtyId === undefined;
  const externalEditor = useUIStore((state) => state.externalEditor);
  const draftKey = editorDraftKey(sessionId, filePath);
  const restoredDraftRef = useRef(readEditorDraft(draftKey));
  const restoredDraft = restoredDraftRef.current;
  const draftOwnerRef = useRef(Symbol("file-editor-draft"));
  const onDirtyChangeRef = useRef(onDirtyChange);
  const onNeedsAttentionRef = useRef(onNeedsAttention);
  onDirtyChangeRef.current = onDirtyChange;
  onNeedsAttentionRef.current = onNeedsAttention;
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lineNumbersRef = useRef<HTMLDivElement>(null);
  const syntaxRef = useRef<HTMLPreElement>(null);
  const editTabRef = useRef<HTMLButtonElement>(null);
  const previewTabRef = useRef<HTMLButtonElement>(null);
  const sourceScrollRatioRef = useRef(0);
  const previewScrollRatioRef = useRef(0);
  const viewId = useId();
  const [content, setContent] = useState(restoredDraft?.content ?? initialContent);
  const [fingerprint, setFingerprint] = useState(restoredDraft?.fingerprint ?? initialFingerprint);
  const [savedContent, setSavedContent] = useState(restoredDraft?.savedContent ?? initialContent);
  const [mode, setMode] = useState<"edit" | "preview">(isNotebook ? "preview" : "edit");
  const [saveState, setSaveState] = useState<SaveState>(() => {
    if (!restoredDraft) return "idle";
    if (restoredDraft.saveState === "saving" || restoredDraft.saveState === "reconciling") {
      return restoredDraft.unknownOutcome ? "unknown" : "error";
    }
    return restoredDraft.saveState;
  });
  const [unknownOutcome, setUnknownOutcome] = useState<SshWriteOutcomeUnknown | null>(restoredDraft?.unknownOutcome ?? null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findIndex, setFindIndex] = useState(-1);
  const [previewMatchCount, setPreviewMatchCount] = useState(0);
  const [closeConfirm, setCloseConfirm] = useState(false);
  const [draftCopyState, setDraftCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [operationError, setOperationError] = useState<OperationError | null>(null);
  const [reloadPending, setReloadPending] = useState(false);
  const dirty = content !== savedContent;
  const previewable = isMarkdown;
  const lines = useMemo(() => content.split("\n"), [content]);
  // 语法分类挂在防抖后的值上；等待分类时同步渲染纯文本，避免透明
  // textarea 后面的可见内容落后于输入。行号列同样保持实时。
  const debouncedContent = useDebouncedValue(content, 200);
  const debouncedFindQuery = useDebouncedValue(findQuery, 150);
  const debouncedHighlightedLines = useMemo(
    () => isMarkdown ? highlightMarkdownSource(debouncedContent) : null,
    [debouncedContent, isMarkdown],
  );
  const highlightedLines = isMarkdown && debouncedContent !== content
    ? lines.map((line) => [{ kind: "text" as const, text: line }])
    : debouncedHighlightedLines;
  const matches = useMemo(() => {
    if (!debouncedFindQuery) return [] as number[];
    const found: number[] = [];
    const haystack = content.toLocaleLowerCase();
    const needle = debouncedFindQuery.toLocaleLowerCase();
    let offset = 0;
    while (offset <= haystack.length - needle.length) {
      const index = haystack.indexOf(needle, offset);
      if (index < 0) break;
      found.push(index);
      offset = index + Math.max(needle.length, 1);
    }
    return found;
  }, [content, debouncedFindQuery]);

  useEffect(() => {
    if (!sessionId) return;
    return registerDirtyDraft({
      owner: draftOwnerRef.current,
      sessionId,
      filePath,
      // The following effect publishes the current value after registration;
      // starting clean keeps this effect independent from every keystroke.
      dirty: false,
      requestConfirmation: () => {
        onNeedsAttentionRef.current?.();
        setCloseConfirm(true);
      },
    });
  }, [filePath, sessionId]);

  useEffect(() => {
    updateDirtyDraft(draftOwnerRef.current, dirty);
    onDirtyChangeRef.current?.(dirty);
  }, [dirty]);

  useLayoutEffect(() => {
    if (mode !== "edit") return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.scrollTop = scrollTopForPosition(
      sourceScrollRatioRef.current,
      textarea.scrollHeight,
      textarea.clientHeight,
    );
    if (lineNumbersRef.current) lineNumbersRef.current.scrollTop = textarea.scrollTop;
    if (syntaxRef.current) syntaxRef.current.scrollTop = textarea.scrollTop;
  }, [mode]);

  useEffect(() => {
    retainEditorDraft(draftKey, { content, savedContent, fingerprint, saveState, unknownOutcome });
  }, [content, draftKey, fingerprint, saveState, savedContent, unknownOutcome]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const selectMatch = (direction: 1 | -1) => {
    const matchCount = mode === "preview" && isMarkdown ? previewMatchCount : matches.length;
    if (matchCount === 0) return;
    const next = direction === 1
      ? (findIndex + 1 + matchCount) % matchCount
      : (findIndex - 1 + matchCount) % matchCount;
    setFindIndex(next);
    if (mode === "preview" && isMarkdown) return;
    window.requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      const start = matches[next];
      textarea.focus();
      textarea.setSelectionRange(start, start + findQuery.length);
    });
  };

  const save = async () => {
    if (remoteDisconnected || !dirty || saveState === "saving" || saveState === "reconciling" || saveState === "unknown") return;
    setSaveState("saving");
    setUnknownOutcome(null);
    setOperationError(null);
    try {
      const result = remotePtyId === undefined
        ? await fsWriteTextFile(filePath, content, fingerprint)
        : await sshWriteTextFile(remotePtyId, filePath, content, fingerprint);
      if (result.status === "conflict") {
        setOperationError(null);
        setSaveState("conflict");
        return;
      }
      setFingerprint(result.fingerprint);
      setSavedContent(content);
      setOperationError(null);
      setSaveState("saved");
      window.setTimeout(() => setSaveState((state) => state === "saved" ? "idle" : state), 1600);
    } catch (error) {
      const outcome = remotePtyId === undefined ? null : parseSshWriteOutcomeUnknown(error);
      if (outcome) {
        setUnknownOutcome(outcome);
        setOperationError(null);
        setSaveState("unknown");
        return;
      }
      setOperationError({ operation: "save", kind: classifyFileOperationError(error), detail: String(error) });
      setSaveState("error");
    }
  };

  const reconcileUnknownSave = async () => {
    if (remotePtyId === undefined || !unknownOutcome || saveState === "reconciling") return;
    setSaveState("reconciling");
    try {
      const { result } = await sshReconcileOutcomeUnknownTextWrite(
        remotePtyId,
        filePath,
        unknownOutcome.token,
      );
      if (result.status === "conflict") {
        setUnknownOutcome(null);
        setSaveState("conflict");
        return;
      }
      setFingerprint(result.fingerprint);
      setSavedContent(content);
      setUnknownOutcome(null);
      setSaveState("saved");
      window.setTimeout(() => setSaveState((state) => state === "saved" ? "idle" : state), 1600);
    } catch {
      // The connection may still be down. Keep the signed outcome token and
      // draft mounted so the user can reconnect and retry the same check.
      setSaveState("unknown");
    }
  };

  const reload = async () => {
    if (remoteDisconnected || reloadPending) return;
    setReloadPending(true);
    setOperationError(null);
    try {
      const result = remotePtyId === undefined
        ? await fsReadFile(filePath)
        : await sshReadFile(remotePtyId, filePath);
      if (result.kind !== "text" || !result.fingerprint) {
        setOperationError({ operation: "reload", kind: "unsupported", detail: "" });
        setSaveState("error");
        return;
      }
      setContent(result.content);
      setSavedContent(result.content);
      setFingerprint(result.fingerprint);
      setUnknownOutcome(null);
      setOperationError(null);
      setSaveState("idle");
      setCloseConfirm(false);
    } catch (error) {
      setOperationError({ operation: "reload", kind: classifyFileOperationError(error), detail: String(error) });
      setSaveState("error");
    } finally {
      setReloadPending(false);
    }
  };

  const operationErrorBody = operationError?.kind === "permission"
    ? t("preview.editor.error_permission")
    : operationError?.kind === "disconnected"
      ? t("preview.editor.error_disconnected")
      : operationError?.kind === "unsupported"
        ? t("preview.editor.error_unsupported")
        : operationError?.operation === "reload"
          ? t("preview.editor.reload_failed_body")
          : t("preview.editor.save_failed_body");

  const copyDraft = async () => {
    const copied = await copyText(content);
    setDraftCopyState(copied ? "copied" : "failed");
    if (copied) window.setTimeout(() => setDraftCopyState("idle"), 1600);
  };

  const switchMode = (nextMode: "edit" | "preview", focusTab = false) => {
    if (isNotebook || nextMode === mode || (nextMode === "preview" && !previewable)) return;
    if (mode === "edit") {
      const textarea = textareaRef.current;
      if (textarea) {
        const ratio = normalizedScrollPosition(textarea.scrollTop, textarea.scrollHeight, textarea.clientHeight);
        sourceScrollRatioRef.current = ratio;
        previewScrollRatioRef.current = ratio;
      }
    } else {
      sourceScrollRatioRef.current = previewScrollRatioRef.current;
    }
    setMode(nextMode);
    if (focusTab) {
      window.requestAnimationFrame(() => (nextMode === "edit" ? editTabRef : previewTabRef).current?.focus());
    }
  };

  const handleModeTabKey = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!previewable) return;
    let nextMode: "edit" | "preview" | null = null;
    if (event.key === "ArrowLeft" || event.key === "Home") nextMode = "edit";
    if (event.key === "ArrowRight" || event.key === "End") nextMode = "preview";
    if (!nextMode) return;
    event.preventDefault();
    switchMode(nextMode, true);
  };

  const requestClose = () => {
    if (dirty) {
      setCloseConfirm(true);
      return;
    }
    discardEditorDraft(draftKey);
    onClose();
  };

  const cancelClose = () => {
    cancelDirtyDraftAction(draftOwnerRef.current);
    setCloseConfirm(false);
  };

  const discardAndContinue = () => {
    if (hasPendingDirtyDraftAction(draftOwnerRef.current)) {
      // The deferred action may itself require a second safety confirmation
      // (for example, closing a running terminal). Make the user's discard
      // decision real before resuming it so a still-mounted editor cannot keep
      // showing content that the central guard now considers clean.
      setCloseConfirm(false);
      setContent(savedContent);
      discardEditorDraft(draftKey);
      confirmDirtyDraftDiscard(draftOwnerRef.current);
      return;
    }
    discardEditorDraft(draftKey);
    onClose();
  };

  const statusLabel = remoteDisconnected
    ? t("preview.editor.remote_disconnected")
    : saveState === "saving"
    ? t("preview.editor.saving")
    : saveState === "reconciling"
      ? t("preview.editor.reconciling")
    : saveState === "saved"
      ? t("preview.editor.saved")
      : saveState === "unknown"
        ? t("preview.editor.outcome_pending")
      : dirty
        ? t("preview.editor.unsaved")
        : t("preview.editor.clean");

  return (
    <div className="file-editor-surface" onKeyDown={(event) => {
      if (event.key === "Escape" && dirty) {
        event.stopPropagation();
        setCloseConfirm(true);
      }
      if (!isNotebook && (event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
      if (!isNotebook && (event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "f") {
        event.preventDefault();
        setFindOpen(true);
      }
    }}>
      <div className="file-editor-header">
        <div className="file-editor-identity">
          <span className="file-editor-kicker">{isRemote ? t("preview.editor.ssh") : t("preview.editor.local")}</span>
          <span className="file-editor-name" title={filePath}>{fileName}</span>
          {dirty && <span className="file-editor-dirty" aria-label={t("preview.editor.unsaved")} />}
        </div>
        <div className="file-editor-actions">
          {isNotebook ? (
            <span className="file-editor-kicker">{t("preview.notebook.read_only")}</span>
          ) : (
            <div className="file-editor-mode" role="tablist" aria-label={t("preview.editor.mode")}>
              <button ref={editTabRef} id={`${viewId}-edit-tab`} role="tab" aria-controls={`${viewId}-panel`} aria-selected={mode === "edit"} tabIndex={mode === "edit" ? 0 : -1} data-active={mode === "edit"} onKeyDown={handleModeTabKey} onClick={() => switchMode("edit")}>{t("preview.editor.edit")}</button>
              {previewable && <button ref={previewTabRef} id={`${viewId}-preview-tab`} role="tab" aria-controls={`${viewId}-panel`} aria-selected={mode === "preview"} tabIndex={mode === "preview" ? 0 : -1} data-active={mode === "preview"} onKeyDown={handleModeTabKey} onClick={() => switchMode("preview")}>{t("preview.editor.preview")}</button>}
            </div>
          )}
          <button className="file-editor-icon-button" onClick={requestClose} title={t("common.close")} aria-label={t("common.close")}>
            <CloseIcon size={11} strokeWidth={2.5} />
          </button>
        </div>
      </div>

      {(saveState === "conflict" || saveState === "unknown" || saveState === "reconciling" || saveState === "error") && (
        <div className="file-editor-alert" role="alert">
          <div>
            <strong>{saveState === "conflict"
              ? t("preview.editor.conflict_title")
              : saveState === "unknown" || saveState === "reconciling"
                ? t("preview.editor.outcome_unknown_title")
                : t(operationError?.operation === "reload"
                  ? "preview.editor.reload_failed"
                  : "preview.editor.save_failed")}</strong>
            <span>{saveState === "conflict"
              ? t("preview.editor.conflict_body")
              : saveState === "unknown" || saveState === "reconciling"
                ? t(unknownOutcome?.cleanupPending
                  ? "preview.editor.outcome_unknown_cleanup_body"
                  : "preview.editor.outcome_unknown_body")
                : operationErrorBody}</span>
            {saveState === "error" && operationError?.detail ? (
              <span title={operationError.detail} style={{ display: "block", fontSize: "var(--fs-meta)", fontFamily: "var(--font-mono)", color: "var(--c-text-5)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{operationError.detail}</span>
            ) : null}
          </div>
          <div className="file-editor-alert-actions">
            <button onClick={() => void copyDraft()}>{t(draftCopyState === "copied"
              ? "preview.editor.draft_copied"
              : draftCopyState === "failed"
                ? "preview.editor.copy_failed"
                : "preview.editor.copy_draft")}</button>
            {saveState === "unknown" || saveState === "reconciling"
              ? <button data-editor-action="reconcile" disabled={saveState === "reconciling"} onClick={() => void reconcileUnknownSave()}>{t("preview.editor.check_result")}</button>
              : <button data-editor-action="reload" disabled={remoteDisconnected || reloadPending} onClick={() => void reload()}>{t(reloadPending
                ? "preview.editor.reloading"
                : "preview.editor.reload")}</button>}
          </div>
        </div>
      )}

      {closeConfirm && (
        <div className="file-editor-close-confirm" role="alert">
          <span>{t("preview.editor.close_warning")}</span>
          <div>
            <button onClick={cancelClose}>{t("common.cancel")}</button>
            <button data-danger="true" onClick={discardAndContinue}>{t("preview.editor.discard")}</button>
          </div>
        </div>
      )}

      {findOpen && (
        <div className="file-editor-find">
          <input
            autoFocus
            value={findQuery}
            onChange={(event) => { setFindQuery(event.target.value); setFindIndex(-1); }}
            onKeyDown={(event) => {
              if (event.key === "Enter") { event.preventDefault(); selectMatch(event.shiftKey ? -1 : 1); }
              if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setFindOpen(false); textareaRef.current?.focus(); }
            }}
            placeholder={t("preview.editor.find_placeholder")}
            aria-label={t("preview.editor.find_placeholder")}
          />
          <span aria-live="polite" aria-atomic="true">{(mode === "preview" && isMarkdown ? previewMatchCount : matches.length) === 0 ? "0/0" : `${Math.max(findIndex + 1, 1)}/${mode === "preview" && isMarkdown ? previewMatchCount : matches.length}`}</span>
          <button onClick={() => selectMatch(-1)} aria-label={t("preview.editor.previous_match")}>↑</button>
          <button onClick={() => selectMatch(1)} aria-label={t("preview.editor.next_match")}>↓</button>
          <button onClick={() => setFindOpen(false)} aria-label={t("common.close")}><CloseIcon size={10} /></button>
        </div>
      )}

      <div id={`${viewId}-panel`} className="file-editor-paper" role="tabpanel" aria-labelledby={isNotebook ? undefined : `${viewId}-${mode}-tab`} aria-label={isNotebook ? t("preview.notebook.read_only") : undefined}>
        {mode === "preview" && isNotebook ? (
          <NotebookPreview content={content} />
        ) : mode === "preview" && isMarkdown ? (
          <MarkdownPreview content={content} fill findQuery={debouncedFindQuery} activeFindIndex={findIndex} initialScrollRatio={previewScrollRatioRef.current} onMatchCountChange={setPreviewMatchCount} onScrollRatioChange={(ratio) => { previewScrollRatioRef.current = ratio; }} />
        ) : (
          <div className="file-editor-code">
            <div ref={lineNumbersRef} className="file-editor-lines" aria-hidden="true">
              {lines.map((_, index) => <span key={index}>{index + 1}</span>)}
            </div>
            <div className="file-editor-input" data-highlighted={highlightedLines !== null}>
              {highlightedLines && (
                <pre ref={syntaxRef} className="file-editor-syntax" aria-hidden="true">
                  {highlightedLines.map((line, lineIndex) => (
                    <span className="file-editor-syntax-line" key={lineIndex}>
                      {line.map((segment, segmentIndex) => (
                        <span data-syntax={segment.kind} key={`${segmentIndex}:${segment.text}`}>{segment.text}</span>
                      ))}
                      {lineIndex < highlightedLines.length - 1 ? "\n" : null}
                    </span>
                  ))}
                </pre>
              )}
              <textarea
                ref={textareaRef}
                value={content}
                onChange={(event) => { setContent(event.target.value); setSaveState("idle"); }}
                onScroll={(event) => {
                  sourceScrollRatioRef.current = normalizedScrollPosition(event.currentTarget.scrollTop, event.currentTarget.scrollHeight, event.currentTarget.clientHeight);
                  if (lineNumbersRef.current) lineNumbersRef.current.scrollTop = event.currentTarget.scrollTop;
                  if (syntaxRef.current) {
                    syntaxRef.current.scrollTop = event.currentTarget.scrollTop;
                    syntaxRef.current.scrollLeft = event.currentTarget.scrollLeft;
                  }
                }}
                spellCheck={false}
                aria-label={t("preview.editor.content", { file: fileName })}
              />
            </div>
          </div>
        )}
      </div>

      <div className="file-editor-footer">
        <span className="file-editor-status" data-state={saveState}>{statusLabel}</span>
        <span>{t("preview.editor.lines", { count: lines.length })}</span>
        <span>{formatSize(new TextEncoder().encode(content).length)}</span>
        <div className="file-editor-footer-actions">
          {!isRemote && (
            <button onClick={() => void openInEditorWithToast(externalEditor, filePath)}>{t("preview.editor.external")}</button>
          )}
          {!isNotebook && <button data-editor-action="save" className="file-editor-save" disabled={remoteDisconnected || !dirty || saveState === "saving" || saveState === "reconciling" || saveState === "unknown"} onClick={() => void save()}>{t("preview.editor.save")}</button>}
        </div>
      </div>
    </div>
  );
}

export function FilePreview({ sessionId, filePath, fileName, onClose, onDirtyChange, onNeedsAttention, fill = false, remotePtyId, remote = remotePtyId !== undefined }: FilePreviewProps) {
  const t = useT();
  const [result, setResult] = useState<ReadResult | null>(null);
  const [readError, setReadError] = useState<{ kind: FileOperationErrorKind; detail: string } | null>(null);
  const [readAttempt, setReadAttempt] = useState(0);
  const readingRef = useRef(false);
  const remoteSession = useSessionsStore((state) => !remote
    ? undefined
    : state.sessions.find((session) =>
      (sessionId !== undefined && session.id === sessionId)
      || (remotePtyId !== undefined && session.ptyId === remotePtyId)));

  useEffect(() => {
    let cancelled = false;
    readingRef.current = true;
    if (remote && remotePtyId === undefined) {
      readingRef.current = false;
      setReadError({ kind: "disconnected", detail: "" });
      return;
    }
    setResult(null);
    setReadError(null);
    const read =
      remote ? sshReadFile(remotePtyId!, filePath) : fsReadFile(filePath);
    read
      .then((r) => { if (!cancelled) setResult(r); })
      .catch((error) => {
        if (!cancelled) {
          setReadError({ kind: classifyFileOperationError(error), detail: String(error) });
        }
      })
      .finally(() => {
        if (!cancelled) readingRef.current = false;
      });
    return () => { cancelled = true; };
  }, [filePath, readAttempt, remote, remotePtyId]);

  const retryRead = () => {
    if (readingRef.current) return;
    readingRef.current = true;
    setReadAttempt((attempt) => attempt + 1);
  };

  const reconnectRemote = () => {
    if (!remoteSession?.remote) return;
    useUIStore.getState().openSshConnect({
      host: remoteSession.remote.host,
      user: remoteSession.remote.user,
      port: remoteSession.remote.port,
      authMethod: remoteSession.remote.authMethod,
      identityFile: remoteSession.remote.identityFile,
      injectShellIntegration: remoteSession.remote.injectShellIntegration,
      reconnectSessionId: remoteSession.id,
    });
  };

  const readErrorBody = readError?.kind === "permission"
    ? t("preview.read_failed_permission")
    : readError?.kind === "disconnected"
      ? t("preview.read_failed_disconnected")
      : readError?.kind === "unsupported"
        ? t("preview.read_failed_unsupported")
        : t("preview.read_failed_body");

  const isMarkdown = /\.mdx?$/i.test(fileName);
  const isNotebook = /\.ipynb$/i.test(fileName);
  const textContent = result?.kind === "text"
    ? result.content + (result.truncated ? `\n${t("preview.truncated")}` : "")
    : "";

  if (fill && result?.kind === "text" && result.fingerprint) {
    return (
      <EditorSurface
        key={`${filePath}:${result.fingerprint}`}
        sessionId={sessionId ?? useSessionsStore.getState().activeSessionId}
        filePath={filePath}
        fileName={fileName}
        initialContent={result.content}
        initialFingerprint={result.fingerprint}
        remotePtyId={remotePtyId}
        remote={remote}
        isMarkdown={isMarkdown}
        isNotebook={isNotebook}
        onClose={onClose}
        onDirtyChange={onDirtyChange}
        onNeedsAttention={onNeedsAttention}
      />
    );
  }

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

      {readError ? (
        <div role="alert" style={{ padding: 12, display: "flex", minHeight: 0, flex: fill ? 1 : undefined, flexDirection: "column", alignItems: "flex-start", justifyContent: fill ? "center" : undefined, gap: 7 }}>
          <strong style={{ color: "var(--c-text-2)", fontSize: "var(--fs-secondary)" }}>{t("preview.read_failed")}</strong>
          <span style={{ color: "var(--c-text-5)", fontSize: "var(--fs-secondary)", lineHeight: 1.5 }}>{readErrorBody}</span>
          <span title={readError.detail} style={{ display: "block", maxWidth: "100%", color: "var(--c-text-5)", fontFamily: "var(--font-mono)", fontSize: "var(--fs-meta)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{readError.detail}</span>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={retryRead}>{t("preview.retry")}</button>
            {readError.kind === "disconnected" && remoteSession?.remote ? (
              <button onClick={reconnectRemote}>{t("terminal.exited.reconnect")}</button>
            ) : null}
          </div>
        </div>
      ) : !result ? (
        <div style={{ padding: "12px 14px", display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--c-text-5)", animation: "loadPulse 1.2s var(--ease-in-out) infinite", flexShrink: 0 }} />
          <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)" }}>{t("preview.reading")}</span>
        </div>
      ) : result.kind === "binary" ? (
        <PreviewMessage icon="⊘" text={t("preview.binary", { size: formatSize(result.size) })} />
      ) : result.kind === "toolarge" ? (
        <PreviewMessage icon="⊘" text={t("preview.too_large", { size: formatSize(result.size) })} />
      ) : isNotebook ? (
        <NotebookPreview content={textContent} />
      ) : isMarkdown ? (
        <MarkdownPreview content={textContent} fill={fill} />
      ) : (
        <TextPreview content={textContent} fill={fill} />
      )}
    </div>
  );
}
