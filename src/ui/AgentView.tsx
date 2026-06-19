// AgentView — agent 会话视图（中栏）
// 渲染流式回复 / 工具调用 / 文件改动 / 终态结果 + 取消 / 查看 diff / 丢弃改动。
// 替代此前"agent 会话也只开一个空 shell、回复永远看不到"的缺口。

import { useEffect, useRef, useState } from "react";
import { AgentBadge } from "./SessionCard";
import { type Session, type AgentBlock, deriveStatus } from "./types";
import { cancelAgent, discardAgentChanges } from "@/modules/agent/agent-bridge";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";

interface AgentViewProps {
  session: Session;
  onViewDiff: () => void;
}

const AGENT_NAMES: Record<string, string> = { CC: "Claude Code", CX: "Codex" };

function ToolChip({ block }: { block: Extract<AgentBlock, { type: "toolUse" }> }) {
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 9px",
        borderRadius: "var(--r-pill)",
        background: "var(--c-bg-3)",
        border: "1px solid var(--c-border-2)",
        fontSize: "var(--fs-secondary)",
        color: "var(--c-text-3)",
        fontFamily: "var(--font-mono)",
        maxWidth: "100%",
      }}
    >
      <span style={{ color: "var(--c-accent)" }}>⚙</span>
      <span style={{ fontWeight: 600 }}>{block.name}</span>
      {block.summary && (
        <span
          style={{
            color: "var(--c-text-5)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: 320,
          }}
        >
          {block.summary.length > 80 ? block.summary.slice(0, 80) + "…" : block.summary}
        </span>
      )}
    </div>
  );
}

export function AgentView({ session, onViewDiff }: AgentViewProps) {
  const refreshGit = useSessionsStore((s) => s.refreshGit);
  const addNotification = useUIStore((s) => s.addNotification);
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const status = deriveStatus(session);
  const running = status === "running";
  const fileChanges = session.blocks.filter(
    (b): b is Extract<AgentBlock, { type: "fileChange" }> => b.type === "fileChange",
  );
  const toolUses = session.blocks.filter(
    (b): b is Extract<AgentBlock, { type: "toolUse" }> => b.type === "toolUse",
  );
  const hasChanges = fileChanges.length > 0;

  // 跟随底部：新内容流入时自动滚到底
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [session.reply, session.blocks.length, session.result, session.error]);

  async function handleCancel() {
    if (session.procId == null) return;
    try {
      await cancelAgent(session.procId);
    } catch (e) {
      addNotification({ id: crypto.randomUUID(), type: "error", message: String(e), sessionTitle: session.title, sessionId: session.id });
    }
  }

  async function handleDiscard() {
    if (session.procId == null) return;
    setBusy(true);
    try {
      const delta = await discardAgentChanges(session.procId);
      refreshGit(session.id);
      addNotification({
        id: crypto.randomUUID(),
        type: "success",
        message: `已丢弃本次改动（${delta.agentOnly.length} 个文件）`,
        sessionTitle: session.title,
        sessionId: session.id,
      });
    } catch (e) {
      addNotification({ id: crypto.randomUUID(), type: "error", message: String(e), sessionTitle: session.title, sessionId: session.id });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "var(--c-bg-white)", overflow: "hidden", minWidth: 0 }}>
      {/* 头部 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "10px 16px",
          borderBottom: "1px solid var(--c-border-1)",
          flexShrink: 0,
        }}
      >
        <AgentBadge agent={session.agent} size={22} />
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
          <span style={{ fontSize: "var(--fs-body)", fontWeight: 600, color: "var(--c-text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {session.title}
          </span>
          <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)" }}>
            {session.agent ? AGENT_NAMES[session.agent] : "Agent"} · {session.dir}
          </span>
        </div>
        {running && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: "var(--fs-secondary)", color: "var(--c-accent)", fontWeight: 600 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--c-accent)", animation: "pulseDot 1.3s ease-in-out infinite" }} />
            运行中
          </span>
        )}
        {running && (
          <button
            onClick={handleCancel}
            style={{
              padding: "5px 12px",
              borderRadius: "var(--r-btn)",
              border: "1px solid var(--c-border-2)",
              background: "transparent",
              color: "var(--c-text-2)",
              fontSize: "var(--fs-secondary)",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            取消
          </button>
        )}
      </div>

      {/* 正文滚动区 */}
      <div ref={scrollRef} className="no-scrollbar" style={{ flex: 1, overflowY: "auto", padding: "16px 18px" }}>
        {/* 初始 prompt */}
        {session.prompt && (
          <div
            style={{
              background: "var(--c-bg-2)",
              border: "1px solid var(--c-border-2)",
              borderRadius: "var(--r-card)",
              padding: "10px 12px",
              marginBottom: 16,
              fontSize: "var(--fs-body)",
              color: "var(--c-text-2)",
              whiteSpace: "pre-wrap",
              lineHeight: 1.6,
            }}
          >
            <div style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontWeight: 600, marginBottom: 4 }}>你</div>
            {session.prompt}
          </div>
        )}

        {/* 工具调用 */}
        {toolUses.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
            {toolUses.map((b, i) => (
              <ToolChip key={i} block={b} />
            ))}
          </div>
        )}

        {/* 流式正文 */}
        {session.reply ? (
          <div
            style={{
              borderLeft: "2px solid var(--c-accent)",
              paddingLeft: 12,
              fontSize: "var(--fs-block)",
              color: "var(--c-text-2)",
              lineHeight: 1.7,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {session.reply}
            {running && <span style={{ animation: "blink 1s step-end infinite" }}>▍</span>}
          </div>
        ) : running ? (
          <div style={{ fontSize: "var(--fs-body)", color: "var(--c-text-5)" }}>等待 agent 响应…</div>
        ) : session.result ? (
          <div style={{ borderLeft: "2px solid var(--c-accent)", paddingLeft: 12, fontSize: "var(--fs-block)", color: "var(--c-text-2)", lineHeight: 1.7, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {session.result}
          </div>
        ) : null}

        {/* 错误 */}
        {session.error && (
          <div
            style={{
              marginTop: 16,
              background: "var(--c-error-bg)",
              border: "1px solid var(--c-error)",
              borderRadius: "var(--r-card)",
              padding: "10px 12px",
              fontSize: "var(--fs-body)",
              color: "var(--c-error)",
              whiteSpace: "pre-wrap",
            }}
          >
            {session.error}
          </div>
        )}

        {/* 文件改动汇总 */}
        {hasChanges && (
          <div style={{ marginTop: 18 }}>
            <div style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontWeight: 600, marginBottom: 6 }}>
              本次改动（{fileChanges.length}）
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              {fileChanges.map((f, i) => (
                <div key={i} style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-3)", fontFamily: "var(--font-mono)" }}>
                  {f.path}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 底部行动条（终态且有改动时） */}
      {!running && (session.runState === "completed" || session.runState === "failed") && hasChanges && (
        <div
          style={{
            borderTop: "1px solid var(--c-border-1)",
            padding: "10px 16px",
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", marginRight: "auto" }}>
            {session.costUsd != null ? `成本 $${session.costUsd.toFixed(4)}` : "已写入工作区"}
          </span>
          <button
            onClick={handleDiscard}
            disabled={busy}
            style={{
              padding: "6px 12px",
              borderRadius: "var(--r-btn)",
              border: "1px solid var(--c-border-2)",
              background: "transparent",
              color: "var(--c-text-2)",
              fontSize: "var(--fs-secondary)",
              fontWeight: 500,
              cursor: busy ? "default" : "pointer",
              opacity: busy ? 0.6 : 1,
            }}
          >
            丢弃本次改动
          </button>
          <button
            onClick={onViewDiff}
            style={{
              padding: "6px 12px",
              borderRadius: "var(--r-btn)",
              border: "none",
              background: "#27272a",
              color: "#fff",
              fontSize: "var(--fs-secondary)",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            查看 diff
          </button>
        </div>
      )}
    </div>
  );
}
