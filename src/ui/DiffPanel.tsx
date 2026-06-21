import { useEffect, useState } from "react";
import { type Session } from "./types";
import {
  gitDiff,
  gitAheadBehind,
  type FileDiff,
  type RemoteState,
} from "@/modules/git/git-bridge";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { openInEditor } from "@/modules/editor/open";
import { isSessionBusy } from "@/modules/terminal/lib/agent-lifecycle";
import { CloseIcon, RefreshIcon, PanelEmptyState, PanelLoadingState } from "./shared";

interface DiffPanelProps {
  session: Session;
  onClose?: () => void;
  embedded?: boolean;
}

function MiniDiff({ diff }: { diff?: FileDiff }) {
  if (!diff) {
    return <div style={{ padding: "8px 10px", fontSize: "var(--fs-meta)", color: "var(--c-text-5)" }}>加载中…</div>;
  }
  if (diff.kind === "binary") {
    return <div style={{ padding: "8px 10px", fontSize: "var(--fs-meta)", color: "var(--c-text-5)" }}>二进制文件</div>;
  }
  if (diff.kind === "tooLarge") {
    return <div style={{ padding: "8px 10px", fontSize: "var(--fs-meta)", color: "var(--c-text-5)" }}>文件过大（{Math.round(diff.bytes / 1024)} KB），未展开</div>;
  }
  if (diff.kind === "metadataOnly") {
    return <div style={{ padding: "8px 10px", fontSize: "var(--fs-meta)", color: "var(--c-text-5)" }}>仅元数据变更（{diff.change}）</div>;
  }
  const lines = diff.patch.split("\n");
  return (
    <div style={{ fontSize: "var(--fs-meta)", fontFamily: "var(--font-mono)", borderRadius: "0 0 var(--r-btn) var(--r-btn)", overflow: "auto" }} className="no-scrollbar">
      {lines.map((line, i) => {
        const isHunk = line.startsWith("@@") || line.startsWith("---") || line.startsWith("+++");
        const isAdd = !isHunk && line.startsWith("+");
        const isDel = !isHunk && line.startsWith("-");
        return (
          <div
            key={`${i}-${line.slice(0, 16)}`}
            style={{
              padding: "1px 8px",
              background: isAdd ? "var(--c-diff-add-bg)" : isDel ? "var(--c-diff-del-bg)" : "transparent",
              color: isAdd ? "var(--c-diff-add-text)" : isDel ? "var(--c-diff-del-text)" : "var(--c-text-6)",
              whiteSpace: "pre",
            }}
          >
            {line || " "}
          </div>
        );
      })}
      {diff.truncated && <div style={{ padding: "4px 8px", color: "var(--c-text-5)" }}>… 已截断</div>}
    </div>
  );
}

function FileStatusBadge({ status }: { status: string }) {
  const colors: Record<string, { bg: string; text: string; border?: string }> = {
    M: { bg: "var(--c-bg-3)", text: "var(--c-text-4)" },
    A: { bg: "var(--c-success-bg)", text: "var(--c-success)" },
    D: { bg: "var(--c-error-bg)", text: "var(--c-error)" },
    R: { bg: "color-mix(in srgb, #3b82f6 12%, transparent)", text: "#3b82f6" },
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
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--c-text-5)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: expanded ? "rotate(90deg)" : "none", transition: "transform var(--duration-fast) ease", flexShrink: 0 }}>
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
        borderLeft: accentBorder ? "2px solid var(--c-success)" : "none",
        marginLeft: accentBorder ? -1 : 0,
      }}
    >
      {chevronIcon(expanded)}
      <span style={{ fontSize: "var(--fs-meta)", fontWeight: 600, color: titleColor ?? "var(--c-text-4)" }}>{title}</span>
      <span style={{ fontSize: "var(--fs-badge)", color: "var(--c-text-4)", background: "var(--c-bg-3)", borderRadius: "var(--r-pill)", padding: "1px 6px", fontFamily: "var(--font-mono)", flexShrink: 0 }}>
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
      return `${remote.branch} · 无上游`;
    case "detached":
      return `游离 HEAD @ ${remote.oid.slice(0, 7)}`;
    case "unborn":
      return "尚无提交";
    case "unknown":
      return "Git 状态未知";
  }
}

export function DiffPanel({ session, onClose, embedded }: DiffPanelProps) {
  const repoPath = session.dir;
  const nonce = useSessionsStore((s) => s.gitNonce[session.id] ?? 0);
  const busy = isSessionBusy(session);

  const files = session.changes?.files ?? [];
  const branch = session.branch || "";
  const summary = session.changes?.summary ?? "";
  const notGit = session.gitState === "notGit";
  const loading = session.gitState !== "repo" && session.gitState !== "notGit" && !session.changes;

  const [remote, setRemote] = useState<RemoteState | null>(null);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, FileDiff>>({});
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});

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

  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => {
      useSessionsStore.getState().refreshGit(session.id);
    }, 10_000);
    return () => clearInterval(timer);
  }, [busy, session.id]);

  async function toggleFile(path: string) {
    if (expandedFile === path) {
      setExpandedFile(null);
      return;
    }
    setExpandedFile(path);
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
      <div key={file.path} className="diff-file-row" style={{ background: "var(--c-bg-white)", borderBottom: "1px solid var(--c-border-1)", overflow: "hidden" }}>
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
            title="在外部编辑器打开"
            onClick={(e) => {
              e.stopPropagation();
              const editor = useUIStore.getState().externalEditor;
              openInEditor(editor, `${repoPath}/${file.path}`).catch(() => {
                useUIStore.getState().addToast({
                  sessionId: session.id,
                  title: "未找到编辑器",
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
          <div style={{ animation: "contentIn var(--duration-normal) ease", overflow: "hidden" }}>
            <MiniDiff diff={diffs[file.path]} />
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
          <span style={{ fontSize: "var(--fs-secondary)", fontWeight: 600, color: "var(--c-text-primary)" }}>改动</span>
          <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-4)", fontFamily: "var(--font-mono)" }}>⎇ {branch || "-"}</span>
          {hasChanges && summary && (
            <span style={{ marginLeft: "auto", fontSize: "var(--fs-meta)", fontWeight: 600, color: "var(--c-text-3)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>{summary}</span>
          )}
          <button
            onClick={refresh}
            title="刷新 Git 状态"
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
              title="关闭面板"
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
        <div style={{ padding: "6px 12px", borderBottom: "1px solid var(--c-border-1)", flexShrink: 0, display: "flex", alignItems: "center" }}>
          <span style={{ fontSize: "var(--fs-meta)", fontWeight: 600, color: "var(--c-text-3)", fontFamily: "var(--font-mono)" }}>{summary}</span>
        </div>
      )}

      <div style={{ flex: 1, overflowY: "auto" }} className="no-scrollbar">
        {loading ? (
          <PanelLoadingState label="git status" />
        ) : notGit ? (
          <PanelEmptyState label="非 Git 仓库" sublabel={repoPath} />
        ) : !hasChanges ? (
          <PanelEmptyState icon={checkIcon} label="工作区干净" />
        ) : (
          <div style={{ padding: "6px" }}>
            {(() => {
              const sections = [
                { key: "staged", title: "已暂存", files: stagedFiles, titleColor: "var(--c-success)", accentBorder: true },
                { key: "unstaged", title: "未暂存", files: unstagedFiles, titleColor: "var(--c-text-4)", accentBorder: false },
                { key: "untracked", title: "未追踪", files: untrackedFiles, titleColor: "var(--c-text-5)", accentBorder: false },
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
        <div style={{ borderTop: "1px solid var(--c-border-1)", padding: "4px 8px 4px 12px", flexShrink: 0, display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ fontSize: "var(--fs-meta-sm)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
            {remoteLabel(remote) || "Git"}
          </div>
          <button
            onClick={refresh}
            title="刷新 Git 状态"
            className="hover-bg"
            style={{ width: 22, height: 22, borderRadius: "var(--r-btn)", border: "none", background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
          >
            <RefreshIcon size={11} />
          </button>
        </div>
      )}
    </div>
  );
}
