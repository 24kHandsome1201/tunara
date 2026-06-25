import { useEffect, useRef, useState } from "react";
import { formatSize, type Session } from "./types";
import {
  gitDiff,
  gitAheadBehind,
  type FileDiff,
  type RemoteState,
} from "@/modules/git/git-bridge";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { openInEditor } from "@/modules/editor/open";
import { useT, t as staticT } from "@/modules/i18n";
import { CloseIcon, RefreshIcon, PanelEmptyState, PanelLoadingState } from "./shared";
import { buildMiniDiffRows, collectHunkTexts, filterRowsByQuery } from "./lib/diff-parse";

interface DiffPanelProps {
  session: Session;
  onClose?: () => void;
  embedded?: boolean;
}

function renderHighlighted(line: string, query: string): React.ReactNode {
  if (!query) return line || " ";
  const lower = line.toLowerCase();
  const needle = query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let found = lower.indexOf(needle, cursor);
  let segIdx = 0;
  while (found !== -1) {
    if (found > cursor) parts.push(line.slice(cursor, found));
    parts.push(
      <mark
        key={`m${segIdx++}`}
        style={{
          background: "var(--c-accent-bg-light)",
          color: "var(--c-accent)",
          borderRadius: 2,
          padding: "0 1px",
        }}
      >
        {line.slice(found, found + needle.length)}
      </mark>,
    );
    cursor = found + needle.length;
    found = lower.indexOf(needle, cursor);
  }
  if (cursor < line.length) parts.push(line.slice(cursor));
  return parts.length === 0 ? line || " " : parts;
}

function MiniDiff({
  diff,
  searchQuery,
  onCopyHunk,
}: {
  diff?: FileDiff;
  searchQuery: string;
  onCopyHunk: (hunkText: string) => void;
}) {
  const t = useT();
  if (!diff) {
    return <div style={{ padding: "8px 10px", fontSize: "var(--fs-meta)", color: "var(--c-text-5)" }}>{t("diff.mini.loading")}</div>;
  }
  if (diff.kind === "binary") {
    return <div style={{ padding: "8px 10px", fontSize: "var(--fs-meta)", color: "var(--c-text-5)" }}>{t("diff.mini.binary")}</div>;
  }
  if (diff.kind === "tooLarge") {
    return <div style={{ padding: "8px 10px", fontSize: "var(--fs-meta)", color: "var(--c-text-5)" }}>{t("diff.mini.too_large", { size: formatSize(diff.bytes) })}</div>;
  }
  if (diff.kind === "metadataOnly") {
    return <div style={{ padding: "8px 10px", fontSize: "var(--fs-meta)", color: "var(--c-text-5)" }}>{t("diff.mini.metadata_only", { change: diff.change })}</div>;
  }
  const allRows = buildMiniDiffRows(diff.patch);
  const q = searchQuery.trim();
  const rows = filterRowsByQuery(allRows, q);
  const hunkTexts = collectHunkTexts(allRows);
  const noMatch = rows.length === 0;

  return (
    <div style={{ fontSize: "var(--fs-meta)", fontFamily: "var(--font-mono)", borderRadius: "0 0 var(--r-btn) var(--r-btn)", overflow: "auto" }} className="no-scrollbar scroll-fade-y">
      {noMatch && (
        <div style={{ padding: "8px 10px", fontSize: "var(--fs-meta)", color: "var(--c-text-5)" }}>{t("diff.mini.no_match", { query: q })}</div>
      )}
      {rows.map((row) => {
        const { key, line, isAdd, isDel, isHunk, hunkIndex } = row;
        if (isHunk) {
          return (
            <div
              key={key}
              className="diff-hunk-row"
              style={{
                position: "relative",
                padding: "1px 8px",
                color: "var(--c-text-5)",
                whiteSpace: "pre",
              }}
            >
              {renderHighlighted(line, q)}
              <button
                className="diff-hunk-copy hover-bg"
                title={t("diff.hunk.copy")}
                onClick={(e) => {
                  e.stopPropagation();
                  const text = hunkTexts[hunkIndex];
                  if (text) onCopyHunk(text);
                }}
                style={{
                  position: "absolute",
                  right: 4,
                  top: "50%",
                  transform: "translateY(-50%)",
                  border: "none",
                  background: "var(--c-bg-2)",
                  color: "var(--c-text-5)",
                  cursor: "pointer",
                  padding: "2px 4px",
                  borderRadius: 3,
                  display: "none",
                  alignItems: "center",
                }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              </button>
            </div>
          );
        }
        return (
          <div
            key={key}
            style={{
              padding: "1px 8px",
              background: isAdd ? "var(--c-diff-add-bg)" : isDel ? "var(--c-diff-del-bg)" : "transparent",
              color: isAdd ? "var(--c-diff-add-text)" : isDel ? "var(--c-diff-del-text)" : "var(--c-text-6)",
              whiteSpace: "pre",
            }}
          >
            {renderHighlighted(line, q)}
          </div>
        );
      })}
      {diff.truncated && <div style={{ padding: "4px 8px", color: "var(--c-text-5)" }}>{t("diff.mini.truncated")}</div>}
    </div>
  );
}

function FileStatusBadge({ status }: { status: string }) {
  const colors: Record<string, { bg: string; text: string; border?: string }> = {
    M: { bg: "var(--c-bg-3)", text: "var(--c-text-4)" },
    A: { bg: "var(--c-success-bg)", text: "var(--c-success)" },
    D: { bg: "var(--c-error-bg)", text: "var(--c-error)" },
    R: { bg: "var(--c-info-bg)", text: "var(--c-info)" },
    "?": { bg: "transparent", text: "var(--c-text-5)", border: "1px dashed var(--c-border-2)" },
  };
  const style = colors[status] ?? colors["M"];
  return (
    <span style={{ fontSize: "var(--fs-badge)", background: style.bg, color: style.text, border: style.border ?? "1px solid transparent", borderRadius: 3, padding: "0 4px", fontWeight: 700, fontFamily: "var(--font-mono)", flexShrink: 0 }}>
      {status}
    </span>
  );
}

const checkIcon = <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--c-success)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>;

const chevronIcon = (expanded: boolean) => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--c-text-5)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: expanded ? "rotate(90deg)" : "none", transition: "transform var(--duration-normal) var(--ease-out-back)", flexShrink: 0 }}>
    <polyline points="9 6 15 12 9 18" />
  </svg>
);

interface SectionHeaderProps {
  title: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  titleColor?: string;
  accentBorder?: boolean;
}

function SectionHeader({ title, count, expanded, onToggle, titleColor, accentBorder }: SectionHeaderProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(); } }}
      className="hover-bg"
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 8px",
        cursor: "pointer",
      }}
    >
      {chevronIcon(expanded)}
      {accentBorder && <span style={{ width: 4, height: 4, borderRadius: "50%", background: "var(--c-success)", flexShrink: 0 }} />}
      <span style={{ fontSize: "var(--fs-meta)", lineHeight: "16px", fontWeight: 600, color: titleColor ?? "var(--c-text-4)" }}>{title}</span>
      <span style={{ fontSize: "var(--fs-meta)", lineHeight: "16px", color: "var(--c-text-5)", background: "var(--c-bg-3)", borderRadius: "var(--r-pill)", padding: "0 6px", fontFamily: "var(--font-mono)", flexShrink: 0, minWidth: 18, textAlign: "center" }}>
        {count}
      </span>
    </div>
  );
}

function remoteLabel(remote: RemoteState | null): string {
  if (!remote) return "";
  switch (remote.state) {
    case "ok":
      return `${remote.upstream} · ↑${remote.ahead} ↓${remote.behind}`;
    case "noUpstream":
      return `${remote.branch} · ${staticT("diff.remote.no_upstream")}`;
    case "detached":
      return staticT("diff.remote.detached", { oid: remote.oid.slice(0, 7) });
    case "unborn":
      return staticT("diff.remote.unborn");
    case "unknown":
      return staticT("diff.remote.unknown");
  }
}

export function DiffPanel({ session, onClose, embedded }: DiffPanelProps) {
  const t = useT();
  const repoPath = session.dir;
  const nonce = useSessionsStore((s) => s.gitNonce[session.id] ?? 0);

  const files = session.changes?.files ?? [];
  const branch = session.branch || "";
  const summary = session.changes?.summary ?? "";
  const notGit = session.gitState === "notGit";
  const loading = session.gitState !== "repo" && session.gitState !== "notGit" && !session.changes;

  const [remote, setRemote] = useState<RemoteState | null>(null);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, FileDiff>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const isComposingRef = useRef(false);
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const raw = window.localStorage.getItem("tunara.diff.collapsedSections");
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("tunara.diff.collapsedSections", JSON.stringify(collapsedSections));
    } catch {
      // 配额满 / 隐私模式 — 忽略即可
    }
  }, [collapsedSections]);

  useEffect(() => {
    let cancelled = false;
    setExpandedFile(null);
    setDiffs({});
    setRemote(null);
    if (notGit) return () => { cancelled = true; };
    gitAheadBehind(repoPath)
      .then((r) => !cancelled && setRemote(r))
      .catch(() => !cancelled && setRemote(null));
    return () => {
      cancelled = true;
    };
  }, [repoPath, session.id, nonce, notGit]);

  useEffect(() => {
    if (expandedFile && !files.some((f) => f.path === expandedFile)) {
      setExpandedFile(null);
    }
  }, [files, expandedFile]);

  async function copyHunk(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      useUIStore.getState().addToast({
        sessionId: session.id,
        title: t("diff.toast.hunk_copied"),
        subtitle: t("diff.toast.hunk_copied_lines", { count: text.split("\n").length }),
        variant: "success",
      });
    } catch {
      useUIStore.getState().addToast({
        sessionId: session.id,
        title: t("diff.toast.copy_failed"),
        subtitle: t("diff.toast.clipboard_unavailable"),
        variant: "error",
      });
    }
  }

  async function toggleFile(path: string) {
    if (expandedFile === path) {
      setExpandedFile(null);
      setSearchQuery("");
      return;
    }
    setExpandedFile(path);
    setSearchQuery("");
    if (!diffs[path]) {
      try {
        const d = await gitDiff(repoPath, path);
        setDiffs((prev) => ({ ...prev, [path]: d }));
      } catch {
        // diff load failed silently
      }
    }
  }

  const hasChanges = files.length > 0;
  const refresh = () => useSessionsStore.getState().refreshGit(session.id);

  const stagedFiles = files.filter((f) => f.stage === "staged");
  const unstagedFiles = files.filter((f) => f.stage === "unstaged");
  const untrackedFiles = files.filter((f) => f.stage === "untracked");

  function renderFileRow(file: typeof files[number]) {
    const isExpanded = expandedFile === file.path;
    return (
      <div key={file.path} className="diff-file-row" style={{ background: "transparent", borderBottom: "1px solid var(--c-border-3)", overflow: "hidden" }}>
        <div
          role="button"
          tabIndex={0}
          onClick={() => toggleFile(file.path)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleFile(file.path); } }}
          className="hover-bg"
          style={{ width: "100%", display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", border: "none", background: "transparent", cursor: "pointer", textAlign: "left" }}
        >
          <FileStatusBadge status={file.status} />
          <span style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-2)", fontFamily: "var(--font-mono)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={file.path}>
            {(() => { const parts = file.path.split("/"); return parts.length > 1 ? parts.slice(-2).join("/") : file.path; })()}
          </span>
          <span
            role="button"
            tabIndex={0}
            className="diff-file-open hover-bg"
            title={t("diff.open_in_editor")}
            onClick={(e) => {
              e.stopPropagation();
              const editor = useUIStore.getState().externalEditor;
              openInEditor(editor, `${repoPath}/${file.path}`).catch(() => {
                useUIStore.getState().addToast({
                  sessionId: session.id,
                  title: t("diff.toast.editor_not_found"),
                  subtitle: editor,
                  variant: "error",
                });
              });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.click();
            }}
            style={{
              width: 18,
              height: 18,
              borderRadius: 4,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              color: "var(--c-text-5)",
              flexShrink: 0,
            }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </span>
          <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>
            +{file.added} −{file.removed}
          </span>
          {chevronIcon(isExpanded)}
        </div>
        {isExpanded && (
          <div style={{ animation: "contentIn var(--duration-normal) var(--ease-out-expo)", overflow: "hidden" }}>
            {diffs[file.path]?.kind === "text" && (
              <div style={{ padding: "4px 8px 2px", borderBottom: "1px solid var(--c-border-3)" }}>
                <input
                  type="text"
                  placeholder={t("diff.search.placeholder")}
                  value={searchQuery}
                  onCompositionStart={() => { isComposingRef.current = true; }}
                  onCompositionEnd={(e) => {
                    isComposingRef.current = false;
                    setSearchQuery((e.target as HTMLInputElement).value);
                  }}
                  onChange={(e) => {
                    if (isComposingRef.current) return;
                    setSearchQuery(e.target.value);
                  }}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return;
                    if (e.key === "Escape") setSearchQuery("");
                  }}
                  style={{
                    width: "100%",
                    fontSize: "var(--fs-meta)",
                    fontFamily: "var(--font-mono)",
                    padding: "3px 6px",
                    background: "var(--c-bg-1)",
                    color: "var(--c-text-2)",
                    border: "1px solid var(--c-border-2)",
                    borderRadius: "var(--r-btn)",
                    outline: "none",
                  }}
                />
              </div>
            )}
            <MiniDiff diff={diffs[file.path]} searchQuery={searchQuery} onCopyHunk={copyHunk} />
          </div>
        )}
      </div>
    );
  }

  const outerStyle = embedded
    ? { display: "flex", flexDirection: "column" as const, flex: 1, overflow: "hidden", minHeight: 0 }
    : { width: "var(--w-panel)", background: "var(--c-bg-2-glass)", borderLeft: "1px solid var(--c-border-1)", display: "flex", flexDirection: "column" as const, flexShrink: 0, overflow: "hidden" };

  return (
    <div style={outerStyle}>
      {!embedded && (
        <div style={{ height: "var(--h-titlebar)", borderBottom: "1px solid var(--c-border-1)", display: "flex", alignItems: "center", padding: "0 12px", gap: 4, flexShrink: 0 }}>
          <span style={{ fontSize: "var(--fs-secondary)", fontWeight: 600, color: "var(--c-text-primary)" }}>{t("diff.title")}</span>
          <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-4)", fontFamily: "var(--font-mono)" }}>⎇ {branch || "-"}</span>
          {hasChanges && summary && (
            <span style={{ marginLeft: "auto", fontSize: "var(--fs-meta)", fontWeight: 600, color: "var(--c-text-3)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>{summary}</span>
          )}
          <button
            onClick={refresh}
            title={t("diff.refresh")}
            className="hover-bg"
            style={{
              marginLeft: hasChanges && summary ? 4 : "auto",
              width: "var(--h-titlebar-control)",
              height: "var(--h-titlebar-control)",
              borderRadius: "var(--r-btn)",
              border: "none",
              background: "transparent",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <RefreshIcon />
          </button>
          {onClose && (
            <button
              onClick={onClose}
              title={t("diff.close_panel")}
              style={{
                marginLeft: 4,
                width: "var(--h-titlebar-control)",
                height: "var(--h-titlebar-control)",
                borderRadius: "var(--r-btn)",
                border: "none",
                background: "transparent",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flexShrink: 0,
              }}
              className="hover-bg"
            >
              <CloseIcon size={13} strokeWidth={2.2} />
            </button>
          )}
        </div>
      )}

      {embedded && hasChanges && summary && (
        <div style={{ padding: "8px 12px", borderBottom: "1px solid var(--c-border-1)", flexShrink: 0, display: "flex", alignItems: "center" }}>
          <span style={{ fontSize: "var(--fs-meta)", fontWeight: 600, color: "var(--c-text-3)", fontFamily: "var(--font-mono)" }}>{summary}</span>
        </div>
      )}

      <div style={{ flex: 1, overflowY: "auto" }} className="no-scrollbar scroll-fade-y">
        {loading ? (
          <PanelLoadingState label="git status" />
        ) : notGit ? (
          <PanelEmptyState label={t("diff.empty.not_git")} sublabel={repoPath} />
        ) : !hasChanges ? (
          <PanelEmptyState icon={checkIcon} label={t("diff.empty.clean")} />
        ) : (
          <div style={{ padding: "6px" }}>
            {(() => {
              const sections = [
                { key: "staged", title: t("diff.section.staged"), files: stagedFiles, titleColor: "var(--c-success)", accentBorder: true },
                { key: "unstaged", title: t("diff.section.unstaged"), files: unstagedFiles, titleColor: "var(--c-text-4)", accentBorder: false },
                { key: "untracked", title: t("diff.section.untracked"), files: untrackedFiles, titleColor: "var(--c-text-5)", accentBorder: false },
              ].filter((s) => s.files.length > 0);
              return sections.map((section) => {
                const collapsed = !!collapsedSections[section.key];
                return (
                  <div key={section.key} style={{ marginBottom: 6 }}>
                    <SectionHeader
                      title={section.title}
                      count={section.files.length}
                      expanded={!collapsed}
                      onToggle={() => setCollapsedSections((prev) => ({ ...prev, [section.key]: !prev[section.key] }))}
                      titleColor={section.titleColor}
                      accentBorder={section.accentBorder}
                    />
                    {!collapsed && section.files.map((file) => renderFileRow(file))}
                  </div>
                );
              });
            })()}
          </div>
        )}
      </div>

      {!notGit && !loading && (
        <div style={{ borderTop: "1px solid var(--c-border-1)", padding: "6px 12px", flexShrink: 0, display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
            {remoteLabel(remote) || "Git"}
          </div>
        </div>
      )}
    </div>
  );
}
