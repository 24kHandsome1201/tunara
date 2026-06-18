// DiffPanel — 右侧审查/diff 面板（300px）
// 含：头（改动+branch+摘要）/ 体（文件列表或空状态）/ 底（commit 输入+按钮+origin状态）

import { useState } from "react";
import { type Session } from "./types";

interface DiffPanelProps {
  session: Session;
}

/** mini diff 展示（首个文件展开态） */
function MiniDiff({ patch }: { patch: string }) {
  const lines = patch.split("\n");
  return (
    <div
      style={{
        fontSize: 11,
        fontFamily: "var(--font-mono)",
        borderRadius: "0 0 var(--r-btn) var(--r-btn)",
        overflow: "hidden",
        marginTop: 0,
      }}
    >
      {lines.map((line, i) => {
        const isAdd = line.startsWith("+");
        const isDel = line.startsWith("-");
        const isHunk = line.startsWith("@@");
        return (
          <div
            key={i}
            style={{
              padding: "1px 8px",
              background: isAdd
                ? "var(--c-diff-add-bg)"
                : isDel
                ? "var(--c-diff-del-bg)"
                : isHunk
                ? "transparent"
                : "transparent",
              color: isAdd
                ? "var(--c-diff-add-text)"
                : isDel
                ? "var(--c-diff-del-text)"
                : "var(--c-text-6)",
              whiteSpace: "pre",
            }}
          >
            {line || " "}
          </div>
        );
      })}
    </div>
  );
}

/** 文件状态标记胶囊（M/A/D/R） */
function FileStatusBadge({ status }: { status: string }) {
  const colors: Record<string, { bg: string; text: string }> = {
    M: { bg: "var(--c-bg-3)", text: "var(--c-text-4)" },
    A: { bg: "var(--c-success-bg)", text: "var(--c-success)" },
    D: { bg: "var(--c-error-bg)", text: "var(--c-error)" },
    R: { bg: "var(--c-bg-3)", text: "var(--c-text-4)" },
  };
  const style = colors[status] ?? colors["M"];
  return (
    <span
      style={{
        fontSize: "var(--fs-badge)",
        background: style.bg,
        color: style.text,
        borderRadius: 3,
        padding: "1px 4px",
        fontWeight: 700,
        fontFamily: "var(--font-mono)",
        flexShrink: 0,
      }}
    >
      {status}
    </span>
  );
}

/** 工作区干净空状态 */
function CleanState() {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "column",
        gap: 10,
        padding: 20,
      }}
    >
      <div
        style={{
          width: 42,
          height: 42,
          borderRadius: "var(--r-input)",
          background: "#eef1ef",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#9aa0a6" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      </div>
      <div style={{ textAlign: "center" }}>
        <div
          style={{
            fontSize: "var(--fs-body)",
            fontWeight: 600,
            color: "var(--c-text-3)",
            marginBottom: 4,
          }}
        >
          工作区干净
        </div>
        <div
          style={{
            fontSize: "var(--fs-meta)",
            color: "var(--c-text-5)",
            fontFamily: "var(--font-mono)",
          }}
        >
          git status · 无未提交改动
        </div>
      </div>
    </div>
  );
}

export function DiffPanel({ session }: DiffPanelProps) {
  const [expandedFile, setExpandedFile] = useState<string | null>(
    session.changedFiles?.[0]?.path ?? null
  );
  const [commitMsg, setCommitMsg] = useState(session.commitMsg ?? "");

  const hasChanges = session.changedFiles && session.changedFiles.length > 0;

  return (
    <div
      style={{
        width: "var(--w-panel)",
        background: "var(--c-bg-2)",
        borderLeft: "1px solid var(--c-border-1)",
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        overflow: "hidden",
      }}
    >
      {/* 头部 40px */}
      <div
        style={{
          height: 40,
          borderBottom: "1px solid var(--c-border-1)",
          display: "flex",
          alignItems: "center",
          padding: "0 14px",
          gap: 8,
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: 12.5,
            fontWeight: 600,
            color: "var(--c-text-primary)",
          }}
        >
          改动
        </span>
        <span
          style={{
            fontSize: 11.5,
            color: "var(--c-text-4)",
            fontFamily: "var(--font-mono)",
          }}
        >
          ⎇ {session.branch}
        </span>
        {hasChanges && session.diffSummary && (
          <span
            style={{
              marginLeft: "auto",
              fontSize: 11.5,
              color: "var(--c-text-6)",
              fontFamily: "var(--font-mono)",
              flexShrink: 0,
            }}
          >
            {session.diffSummary}
          </span>
        )}
      </div>

      {/* 体：文件列表 或 空状态 */}
      <div style={{ flex: 1, overflowY: "auto" }} className="no-scrollbar">
        {!hasChanges ? (
          <CleanState />
        ) : (
          <div style={{ padding: "8px" }}>
            {session.changedFiles!.map((file, idx) => {
              const isExpanded = expandedFile === file.path;
              const isFirst = idx === 0;
              return (
                <div
                  key={file.path}
                  style={{
                    background: "var(--c-bg-white)",
                    border: "1px solid var(--c-border-2)",
                    borderRadius: "var(--r-btn)",
                    marginBottom: 4,
                    overflow: "hidden",
                  }}
                >
                  {/* 文件卡头 */}
                  <button
                    onClick={() => setExpandedFile(isExpanded ? null : file.path)}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "7px 10px",
                      border: "none",
                      background: "transparent",
                      cursor: "pointer",
                      textAlign: "left",
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLButtonElement).style.background = "var(--c-bg-hover)";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                    }}
                  >
                    <FileStatusBadge status={file.status} />
                    <span
                      style={{
                        fontSize: "var(--fs-secondary)",
                        color: "var(--c-text-2)",
                        fontFamily: "var(--font-mono)",
                        flex: 1,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {file.path.split("/").pop() ?? file.path}
                    </span>
                    <span
                      style={{
                        fontSize: "var(--fs-meta)",
                        color: "var(--c-text-5)",
                        fontFamily: "var(--font-mono)",
                        flexShrink: 0,
                      }}
                    >
                      +{file.added} −{file.removed}
                    </span>
                    {/* 展开箭头 */}
                    <span
                      style={{
                        fontSize: 10,
                        color: "var(--c-text-5)",
                        transform: isExpanded ? "rotate(90deg)" : "none",
                        transition: "transform 0.15s ease",
                        flexShrink: 0,
                      }}
                    >
                      ▸
                    </span>
                  </button>

                  {/* 首个文件默认展开 mini diff */}
                  {isExpanded && (isFirst || true) && file.patch && (
                    <MiniDiff patch={file.patch} />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* 底部：仅有改动时显示 */}
      {hasChanges && (
        <div
          style={{
            borderTop: "1px solid var(--c-border-1)",
            padding: "10px 12px",
            flexShrink: 0,
          }}
        >
          {/* commit 信息输入框 */}
          <input
            type="text"
            value={commitMsg}
            onChange={(e) => setCommitMsg(e.target.value)}
            placeholder="提交说明…"
            style={{
              width: "100%",
              background: "var(--c-bg-white)",
              border: "1px solid var(--c-border-2)",
              borderRadius: "var(--r-input)",
              padding: "7px 10px",
              fontSize: "var(--fs-body)",
              color: "var(--c-text-primary)",
              fontFamily: "var(--font-ui)",
              outline: "none",
              boxSizing: "border-box",
              marginBottom: 8,
            }}
          />

          {/* 提交按钮行 */}
          <div style={{ display: "flex", gap: 6 }}>
            {/* 提交（浅灰） */}
            <button
              style={{
                flex: 1,
                padding: "7px 10px",
                borderRadius: "var(--r-btn)",
                border: "1px solid var(--c-border-2)",
                background: "var(--c-bg-3)",
                color: "var(--c-text-2)",
                fontSize: "var(--fs-body)",
                fontWeight: 500,
                cursor: "pointer",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "var(--c-bg-hover)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "var(--c-bg-3)";
              }}
            >
              提交
            </button>

            {/* 提交并推送（墨黑+上箭头） */}
            <button
              style={{
                flex: 1,
                padding: "7px 10px",
                borderRadius: "var(--r-btn)",
                border: "none",
                background: "#27272a",
                color: "#fff",
                fontSize: "var(--fs-body)",
                fontWeight: 500,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 5,
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "#3f3f46";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "#27272a";
              }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="19" x2="12" y2="5" />
                <polyline points="5 12 12 5 19 12" />
              </svg>
              提交并推送
            </button>
          </div>

          {/* origin 领先落后 */}
          <div
            style={{
              marginTop: 7,
              fontSize: "var(--fs-meta)",
              color: "var(--c-text-5)",
              fontFamily: "var(--font-mono)",
              textAlign: "center",
            }}
          >
            origin/{session.branch} · 领先 0 · 落后 0
          </div>
        </div>
      )}
    </div>
  );
}
