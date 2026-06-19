// DiffPanel — 右侧审查/diff 面板（300px）
// 接通真实 git：status / diff / ahead-behind / commit / push（modules/git/git-bridge）。

import { useCallback, useEffect, useState } from "react";
import { type Session } from "./types";
import {
  gitStatus,
  gitDiff,
  gitAheadBehind,
  gitCommit,
  gitPush,
  type FileChange,
  type FileDiff,
  type RemoteState,
} from "@/modules/git/git-bridge";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";

interface DiffPanelProps {
  session: Session;
}

function MiniDiff({ diff }: { diff?: FileDiff }) {
  if (!diff) {
    return <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--c-text-5)" }}>加载中…</div>;
  }
  if (diff.kind === "binary") {
    return <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--c-text-5)" }}>二进制文件</div>;
  }
  if (diff.kind === "tooLarge") {
    return <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--c-text-5)" }}>文件过大（{Math.round(diff.bytes / 1024)} KB），未展开</div>;
  }
  if (diff.kind === "metadataOnly") {
    return <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--c-text-5)" }}>仅元数据变更（{diff.change}）</div>;
  }
  const lines = diff.patch.split("\n");
  return (
    <div style={{ fontSize: 11, fontFamily: "var(--font-mono)", borderRadius: "0 0 var(--r-btn) var(--r-btn)", overflow: "auto" }} className="no-scrollbar">
      {lines.map((line, i) => {
        const isAdd = line.startsWith("+");
        const isDel = line.startsWith("-");
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

function EmptyState({ title, sub }: { title: string; sub: string }) {
  return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 10, padding: 20 }}>
      <div style={{ width: 42, height: 42, borderRadius: "var(--r-input)", background: "var(--c-bg-3)", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#9aa0a6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </div>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: "var(--fs-body)", fontWeight: 600, color: "var(--c-text-3)", marginBottom: 4 }}>{title}</div>
        <div style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)" }}>{sub}</div>
      </div>
    </div>
  );
}

function remoteLabel(remote: RemoteState | null, branch: string): string {
  if (!remote) return "";
  switch (remote.state) {
    case "ok":
      return `${remote.upstream} · 领先 ${remote.ahead} · 落后 ${remote.behind}`;
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

export function DiffPanel({ session }: DiffPanelProps) {
  const repoPath = session.dir;
  const nonce = useSessionsStore((s) => s.gitNonce[session.id] ?? 0);
  const refreshGit = useSessionsStore((s) => s.refreshGit);
  const updateSession = useSessionsStore((s) => s.updateSession);
  const addNotification = useUIStore((s) => s.addNotification);

  const [files, setFiles] = useState<FileChange[]>([]);
  const [branch, setBranch] = useState(session.branch || "");
  const [summary, setSummary] = useState("");
  const [remote, setRemote] = useState<RemoteState | null>(null);
  const [notGit, setNotGit] = useState(false);
  const [loading, setLoading] = useState(true);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Record<string, FileDiff>>({});
  const [commitMsg, setCommitMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const notify = useCallback(
    (type: "error" | "success", message: string) => {
      addNotification({ id: crypto.randomUUID(), type, message, sessionTitle: session.title, sessionId: session.id });
    },
    [addNotification, session.title, session.id],
  );

  // 拉取 status + ahead/behind（会话切换 / nonce bump 时）
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setExpandedFile(null);
    setDiffs({});
    (async () => {
      try {
        const status = await gitStatus(repoPath);
        if (cancelled) return;
        setNotGit(false);
        setFiles(status.files);
        setBranch(status.branch);
        setSummary(status.summary);
        if (status.branch && status.branch !== session.branch) {
          updateSession(session.id, { branch: status.branch });
        }
        gitAheadBehind(repoPath)
          .then((r) => !cancelled && setRemote(r))
          .catch(() => !cancelled && setRemote(null));
      } catch {
        if (cancelled) return;
        setNotGit(true);
        setFiles([]);
        setRemote(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath, session.id, nonce]);

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
      } catch (e) {
        notify("error", `读取 diff 失败：${String(e)}`);
      }
    }
  }

  const hasChanges = files.length > 0;
  const ahead = remote?.state === "ok" ? remote.ahead : 0;
  const canCommit = hasChanges && commitMsg.trim().length > 0 && !busy;
  const canPush = (canCommit || (!hasChanges && ahead > 0)) && !busy;

  async function handleCommit(push: boolean) {
    setBusy(true);
    try {
      if (hasChanges) {
        await gitCommit(repoPath, commitMsg.trim(), files.map((file) => file.path));
      }
      if (push) {
        await gitPush(repoPath);
      }
      setCommitMsg("");
      refreshGit(session.id);
      notify("success", push ? "已提交并推送" : "已提交");
    } catch (e) {
      notify("error", `${push ? "推送" : "提交"}失败：${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ width: "var(--w-panel)", background: "var(--c-bg-2-glass)", borderLeft: "1px solid var(--c-border-1)", display: "flex", flexDirection: "column", flexShrink: 0, overflow: "hidden" }}>
      {/* 头部 */}
      <div style={{ height: 40, borderBottom: "1px solid var(--c-border-1)", display: "flex", alignItems: "center", padding: "0 14px", gap: 8, flexShrink: 0 }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--c-text-primary)" }}>改动</span>
        <span style={{ fontSize: 11.5, color: "var(--c-text-4)", fontFamily: "var(--font-mono)" }}>⎇ {branch || "—"}</span>
        {hasChanges && summary && (
          <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--c-text-6)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>{summary}</span>
        )}
      </div>

      {/* 体 */}
      <div style={{ flex: 1, overflowY: "auto" }} className="no-scrollbar">
        {loading ? (
          <EmptyState title="读取中…" sub="git status" />
        ) : notGit ? (
          <EmptyState title="非 Git 仓库" sub={repoPath} />
        ) : !hasChanges ? (
          <EmptyState title="工作区干净" sub="git status · 无未提交改动" />
        ) : (
          <div style={{ padding: "8px" }}>
            {files.map((file) => {
              const isExpanded = expandedFile === file.path;
              return (
                <div key={file.path} style={{ background: "var(--c-bg-white)", border: "1px solid var(--c-border-2)", borderRadius: "var(--r-btn)", marginBottom: 4, overflow: "hidden" }}>
                  <button
                    onClick={() => toggleFile(file.path)}
                    style={{ width: "100%", display: "flex", alignItems: "center", gap: 6, padding: "7px 10px", border: "none", background: "transparent", cursor: "pointer", textAlign: "left" }}
                    className="hover-bg"
                  >
                    <FileStatusBadge status={file.status} />
                    <span style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-2)", fontFamily: "var(--font-mono)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={file.path}>
                      {file.path.split("/").pop() ?? file.path}
                    </span>
                    <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>
                      +{file.added} −{file.removed}
                    </span>
                    <span style={{ fontSize: 10, color: "var(--c-text-5)", transform: isExpanded ? "rotate(90deg)" : "none", transition: "transform 0.15s ease", flexShrink: 0 }}>▸</span>
                  </button>
                  {isExpanded && <MiniDiff diff={diffs[file.path]} />}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 底部：git 仓库且（有改动或可推送）时显示 */}
      {!notGit && !loading && (hasChanges || ahead > 0) && (
        <div style={{ borderTop: "1px solid var(--c-border-1)", padding: "10px 12px", flexShrink: 0 }}>
          <input
            type="text"
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            placeholder={hasChanges ? "提交说明…" : "无未提交改动"}
            disabled={!hasChanges || busy}
            style={{ width: "100%", background: "var(--c-bg-white)", border: "1px solid var(--c-border-2)", borderRadius: "var(--r-input)", padding: "7px 10px", fontSize: "var(--fs-body)", color: "var(--c-text-primary)", fontFamily: "var(--font-ui)", outline: "none", boxSizing: "border-box", marginBottom: 8, opacity: hasChanges ? 1 : 0.6 }}
          />
          <div style={{ display: "flex", gap: 6 }}>
            <button
              onClick={() => handleCommit(false)}
              disabled={!canCommit}
              style={{ flex: 1, padding: "7px 10px", borderRadius: "var(--r-btn)", border: "1px solid var(--c-border-2)", background: "var(--c-bg-3)", color: "var(--c-text-2)", fontSize: "var(--fs-body)", fontWeight: 500, cursor: canCommit ? "pointer" : "default", opacity: canCommit ? 1 : 0.5 }}
            >
              {busy ? "处理中…" : "提交"}
            </button>
            <button
              onClick={() => handleCommit(true)}
              disabled={!canPush}
              style={{ flex: 1, padding: "7px 10px", borderRadius: "var(--r-btn)", border: "none", background: "#27272a", color: "#fff", fontSize: "var(--fs-body)", fontWeight: 500, cursor: canPush ? "pointer" : "default", opacity: canPush ? 1 : 0.5, display: "flex", alignItems: "center", justifyContent: "center", gap: 5 }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="19" x2="12" y2="5" />
                <polyline points="5 12 12 5 19 12" />
              </svg>
              {hasChanges ? "提交并推送" : "推送"}
            </button>
          </div>
          <div style={{ marginTop: 7, fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)", textAlign: "center" }}>
            {hasChanges ? `将提交 ${files.length} 个文件 · ` : ""}{remoteLabel(remote, branch)}
          </div>
        </div>
      )}
    </div>
  );
}
