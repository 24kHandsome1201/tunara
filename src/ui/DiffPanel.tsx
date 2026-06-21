import { useEffect, useState } from "react";
import { type Session } from "./types";
import {
  gitDiff,
  gitAheadBehind,
  type FileDiff,
  type RemoteState,
} from "@/modules/git/git-bridge";
import { useSessionsStore } from "@/state/sessions";
import { isSessionBusy } from "@/modules/terminal/lib/agent-lifecycle";

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
            key={i}
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
  const colors: Record<string, { bg: string; text: string }> = {
    M: { bg: "var(--c-bg-3)", text: "var(--c-text-4)" },
    A: { bg: "var(--c-success-bg)", text: "var(--c-success)" },
    D: { bg: "var(--c-error-bg)", text: "var(--c-error)" },
    R: { bg: "var(--c-bg-3)", text: "var(--c-text-4)" },
  };
  const style = colors[status] ?? colors["M"];
  return (
    <span style={{ fontSize: "var(--fs-badge)", background: style.bg, color: style.text, borderRadius: 3, padding: "1px 4px", fontWeight: 700, fontFamily: "var(--font-mono)", flexShrink: 0 }}>
      {status}
    </span>
  );
}

function EmptyState({ icon, label, sublabel }: { icon: React.ReactNode; label: string; sublabel?: string }) {
  return (
    <div style={{ padding: "28px 14px", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
      <div style={{ width: 36, height: 36, borderRadius: "50%", background: "var(--c-bg-3)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--c-text-5)" }}>
        {icon}
      </div>
      <span style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-4)" }}>{label}</span>
      {sublabel && <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)", maxWidth: "90%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sublabel}</span>}
    </div>
  );
}

function EmptyClean() {
  return (
    <EmptyState
      icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--c-success)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>}
      label="工作区干净"
    />
  );
}

function EmptyNotGit({ path }: { path: string }) {
  return (
    <EmptyState
      icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>}
      label="非 Git 仓库"
      sublabel={path}
    />
  );
}

function EmptyLoading() {
  return (
    <div style={{ padding: "28px 14px", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
      <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--c-text-5)", animation: "pulseDot 1.2s ease infinite" }} />
      <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)" }}>git status</span>
    </div>
  );
}

function remoteLabel(remote: RemoteState | null, branch: string): string {
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
    default:
      return branch;
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

  const outerStyle = embedded
    ? { display: "flex", flexDirection: "column" as const, flex: 1, overflow: "hidden", minHeight: 0 }
    : { width: "var(--w-panel)", background: "var(--c-bg-2-glass)", borderLeft: "1px solid var(--c-border-1)", display: "flex", flexDirection: "column" as const, flexShrink: 0, overflow: "hidden" };

  return (
    <div style={outerStyle}>
      {!embedded && (
        <div style={{ height: "var(--h-titlebar)", borderBottom: "1px solid var(--c-border-1)", display: "flex", alignItems: "center", padding: "0 12px", gap: 6, flexShrink: 0 }}>
          <span style={{ fontSize: "var(--fs-secondary)", fontWeight: 600, color: "var(--c-text-primary)" }}>改动</span>
          <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-4)", fontFamily: "var(--font-mono)" }}>⎇ {branch || "—"}</span>
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
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 0 1-15.5 6.2" />
              <path d="M3 12A9 9 0 0 1 18.5 5.8" />
              <polyline points="18 2 18.5 5.8 14.8 6.2" />
              <polyline points="6 22 5.5 18.2 9.2 17.8" />
            </svg>
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
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>
      )}

      {embedded && hasChanges && summary && (
        <div style={{ padding: "6px 12px", borderBottom: "1px solid var(--c-border-1)", flexShrink: 0, display: "flex", alignItems: "center" }}>
          <span style={{ fontSize: "var(--fs-meta)", fontWeight: 600, color: "var(--c-text-3)", fontFamily: "var(--font-mono)" }}>{summary}</span>
          <button
            onClick={refresh}
            title="刷新 Git 状态"
            className="hover-bg"
            style={{ marginLeft: "auto", width: 22, height: 22, borderRadius: "var(--r-btn)", border: "none", background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 0 1-15.5 6.2" />
              <path d="M3 12A9 9 0 0 1 18.5 5.8" />
              <polyline points="18 2 18.5 5.8 14.8 6.2" />
              <polyline points="6 22 5.5 18.2 9.2 17.8" />
            </svg>
          </button>
        </div>
      )}

      <div style={{ flex: 1, overflowY: "auto" }} className="no-scrollbar">
        {loading ? (
          <EmptyLoading />
        ) : notGit ? (
          <EmptyNotGit path={repoPath} />
        ) : !hasChanges ? (
          <EmptyClean />
        ) : (
          <div style={{ padding: "6px" }}>
            {files.map((file) => {
              const isExpanded = expandedFile === file.path;
              return (
                <div key={file.path} style={{ background: "var(--c-bg-white)", border: "1px solid var(--c-border-2)", borderRadius: "var(--r-btn)", marginBottom: 3, overflow: "hidden" }}>
                  <button
                    onClick={() => toggleFile(file.path)}
                    className="hover-bg"
                    style={{ width: "100%", display: "flex", alignItems: "center", gap: 6, padding: "5px 8px", border: "none", background: "transparent", cursor: "pointer", textAlign: "left" }}
                  >
                    <FileStatusBadge status={file.status} />
                    <span style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-2)", fontFamily: "var(--font-mono)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={file.path}>
                      {(() => { const parts = file.path.split("/"); return parts.length > 1 ? parts.slice(-2).join("/") : file.path; })()}
                    </span>
                    <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>
                      +{file.added} −{file.removed}
                    </span>
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--c-text-5)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: isExpanded ? "rotate(90deg)" : "none", transition: "transform var(--duration-fast) ease", flexShrink: 0 }}>
                      <polyline points="9 6 15 12 9 18" />
                    </svg>
                  </button>
                  {isExpanded && (
                    <div style={{ animation: "contentIn var(--duration-normal) ease", overflow: "hidden" }}>
                      <MiniDiff diff={diffs[file.path]} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {!notGit && !loading && (
        <div style={{ borderTop: "1px solid var(--c-border-1)", padding: "4px 8px 4px 12px", flexShrink: 0, display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ fontSize: "var(--fs-meta-sm)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
            {remoteLabel(remote, branch) || "Git"}
          </div>
          <button
            onClick={refresh}
            title="刷新 Git 状态"
            className="hover-bg"
            style={{ width: 22, height: 20, borderRadius: "var(--r-btn)", border: "none", background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 0 1-15.5 6.2" />
              <path d="M3 12A9 9 0 0 1 18.5 5.8" />
              <polyline points="18 2 18.5 5.8 14.8 6.2" />
              <polyline points="6 22 5.5 18.2 9.2 17.8" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
