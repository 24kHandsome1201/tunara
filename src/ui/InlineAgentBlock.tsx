// InlineAgentBlock — 内联 AI 回复块
// 左边 2px 橘色条 + agent 角标 + agent 名/会话标题 + 正文 + 行动按钮
// 按约束：「应用补丁」改为「已应用 ✓ / 查看 diff」

import { AgentBadge } from "./SessionCard";
import { type AgentType } from "./types";

interface InlineAgentBlockProps {
  agent: AgentType;
  agentName: string;
  sessionTitle: string;
  content: string;
  /** 是否已应用到文件（M2 mock 始终为 true） */
  applied?: boolean;
  onViewDiff?: () => void;
}

const AGENT_DISPLAY_NAMES: Record<AgentType, string> = {
  CC: "Claude Code",
  CX: "Codex",
  CU: "Cursor",
};

export function InlineAgentBlock({
  agent,
  agentName,
  sessionTitle,
  content,
  applied = true,
  onViewDiff,
}: InlineAgentBlockProps) {
  const displayName = agentName || AGENT_DISPLAY_NAMES[agent];

  return (
    <div
      style={{
        display: "flex",
        margin: "12px 0",
        borderLeft: "2px solid var(--c-accent)",
        paddingLeft: 12,
      }}
    >
      <div style={{ flex: 1 }}>
        {/* 头部：角标 + agent 名 + 会话标题 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 7,
            marginBottom: 8,
          }}
        >
          <AgentBadge agent={agent} size={18} />
          <span
            style={{
              fontSize: "var(--fs-body)",
              fontWeight: 600,
              color: "var(--c-text-primary)",
            }}
          >
            {displayName}
          </span>
          <span
            style={{
              fontSize: "var(--fs-body)",
              color: "var(--c-accent)",
            }}
          >
            · {sessionTitle}
          </span>
        </div>

        {/* 正文 */}
        <div
          style={{
            fontSize: "var(--fs-body)",
            color: "var(--c-text-2)",
            fontFamily: "var(--font-ui)",
            lineHeight: 1.7,
            marginBottom: 10,
            whiteSpace: "pre-wrap",
          }}
        >
          {content}
        </div>

        {/* 行动按钮 */}
        <div style={{ display: "flex", gap: 8 }}>
          {/* 已应用标记（替代「应用补丁」按钮） */}
          <button
            disabled
            style={{
              padding: "5px 12px",
              borderRadius: "var(--r-btn)",
              border: "none",
              background: applied ? "#27272a" : "var(--c-bg-3)",
              color: applied ? "#fff" : "var(--c-text-4)",
              fontSize: "var(--fs-secondary)",
              fontWeight: 500,
              cursor: "default",
              opacity: applied ? 1 : 0.6,
            }}
          >
            {applied ? "已应用 ✓" : "应用中…"}
          </button>

          {/* 查看 diff 按钮 */}
          <button
            onClick={onViewDiff}
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
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "var(--c-bg-hover)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background = "transparent";
            }}
          >
            查看 diff
          </button>
        </div>
      </div>
    </div>
  );
}
