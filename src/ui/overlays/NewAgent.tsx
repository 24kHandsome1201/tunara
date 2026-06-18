// overlays/NewAgent — 新建 Agent 弹层（520px sheet）
// 含：选目录 / CC·CX 可选 / CU 灰置"暂不支持" / ⌘⏎ 创建

import { useState } from "react";
import { type AgentType } from "../types";

interface NewAgentProps {
  /** 初始选中的 agent */
  initialAgent?: AgentType;
  onClose: () => void;
  onCreate: (agent: AgentType, dir: string, prompt: string) => void;
}

interface AgentCardDef {
  id: AgentType;
  name: string;
  desc: string;
  disabled?: boolean;
}

const AGENT_CARDS: AgentCardDef[] = [
  {
    id: "CC",
    name: "Claude Code",
    desc: "Anthropic 官方 CLI，支持多轮对话与自动写盘",
  },
  {
    id: "CX",
    name: "Codex",
    desc: "OpenAI Codex CLI，快速代码生成与补丁应用",
  },
  {
    id: "CU",
    name: "Cursor",
    desc: "暂不支持",
    disabled: true,
  },
];

/** agent 角标（弹层用） */
function AgentBadgeInner({ agent, disabled }: { agent: AgentType; disabled?: boolean }) {
  const styles: Record<AgentType, React.CSSProperties> = {
    CC: {
      background: disabled ? "var(--c-bg-3)" : "var(--c-agent-cc-bg)",
      border: `1px solid ${disabled ? "var(--c-border-2)" : "var(--c-agent-cc-border)"}`,
      color: disabled ? "var(--c-text-5)" : "var(--c-agent-cc-text)",
    },
    CX: {
      background: disabled ? "var(--c-bg-3)" : "var(--c-agent-cx-bg)",
      border: `1px solid ${disabled ? "var(--c-border-2)" : "var(--c-agent-cx-border)"}`,
      color: disabled ? "var(--c-text-5)" : "var(--c-agent-cx-text)",
    },
    CU: {
      background: "var(--c-bg-3)",
      border: "1px solid var(--c-border-2)",
      color: "var(--c-text-5)",
    },
  };

  return (
    <div
      style={{
        width: 28,
        height: 28,
        borderRadius: "var(--r-badge)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 10,
        fontWeight: 700,
        fontFamily: "var(--font-mono)",
        flexShrink: 0,
        ...styles[agent],
      }}
    >
      {agent}
    </div>
  );
}

export function NewAgent({ initialAgent = "CC", onClose, onCreate }: NewAgentProps) {
  const [agentPick, setAgentPick] = useState<AgentType>(initialAgent);
  const [dir] = useState("~/orbit");
  const [prompt, setPrompt] = useState("");

  function handleCreate() {
    if (!prompt.trim()) return;
    onCreate(agentPick, dir, prompt);
    onClose();
  }

  // ⌘⏎ 快捷键
  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      handleCreate();
    }
    if (e.key === "Escape") {
      onClose();
    }
  }

  return (
    <>
      {/* 遮罩 */}
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(20,20,28,0.34)",
          backdropFilter: "blur(4px)",
          zIndex: 200,
          animation: "fadeIn 0.2s ease",
        }}
      />

      {/* Sheet */}
      <div
        onKeyDown={handleKeyDown}
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 520,
          background: "var(--c-bg-white)",
          borderRadius: "var(--r-overlay)",
          boxShadow: "var(--shadow-overlay)",
          zIndex: 201,
          animation: "sheetIn 0.24s ease",
          overflow: "hidden",
        }}
      >
        {/* 头部 */}
        <div style={{ padding: "24px 24px 16px" }}>
          <div
            style={{
              fontSize: "var(--fs-title)",
              fontWeight: 700,
              color: "var(--c-text-primary)",
              marginBottom: 6,
            }}
          >
            新建 Agent
          </div>
          <div
            style={{
              fontSize: "var(--fs-body)",
              color: "var(--c-text-4)",
            }}
          >
            选择工作目录与 agent，在该会话中开始协作。
          </div>
        </div>

        <div style={{ padding: "0 24px 24px" }}>
          {/* 工作目录 */}
          <div style={{ marginBottom: 16 }}>
            <div
              style={{
                fontSize: "var(--fs-secondary)",
                fontWeight: 600,
                color: "var(--c-text-3)",
                marginBottom: 6,
              }}
            >
              工作目录
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "8px 12px",
                border: "1px solid var(--c-border-2)",
                borderRadius: "var(--r-input)",
                background: "var(--c-bg-white)",
                cursor: "pointer",
              }}
            >
              {/* 文件夹图标（琥珀色） */}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--c-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              <span
                style={{
                  flex: 1,
                  fontSize: "var(--fs-body)",
                  fontFamily: "var(--font-mono)",
                  color: "var(--c-text-primary)",
                }}
              >
                {dir}
              </span>
              <span
                style={{
                  fontSize: "var(--fs-secondary)",
                  color: "var(--c-text-5)",
                  marginRight: 4,
                }}
              >
                最近
              </span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--c-text-5)" strokeWidth="2">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </div>
          </div>

          {/* Agent 选择卡 */}
          <div style={{ marginBottom: 16 }}>
            <div
              style={{
                fontSize: "var(--fs-secondary)",
                fontWeight: 600,
                color: "var(--c-text-3)",
                marginBottom: 8,
              }}
            >
              Agent
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {AGENT_CARDS.map((card) => {
                const isSelected = agentPick === card.id && !card.disabled;
                return (
                  <button
                    key={card.id}
                    onClick={() => !card.disabled && setAgentPick(card.id)}
                    disabled={card.disabled}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "10px 14px",
                      borderRadius: "var(--r-card)",
                      border: isSelected
                        ? "1px solid var(--c-accent-border)"
                        : "1px solid var(--c-border-2)",
                      background: isSelected ? "var(--c-accent-bg-soft)" : "var(--c-bg-white)",
                      cursor: card.disabled ? "not-allowed" : "pointer",
                      opacity: card.disabled ? 0.5 : 1,
                      textAlign: "left",
                      width: "100%",
                    }}
                  >
                    <AgentBadgeInner agent={card.id} disabled={card.disabled} />

                    <div style={{ flex: 1 }}>
                      <div
                        style={{
                          fontSize: "var(--fs-body)",
                          fontWeight: 600,
                          color: card.disabled ? "var(--c-text-5)" : "var(--c-text-primary)",
                          marginBottom: 2,
                        }}
                      >
                        {card.name}
                        {card.disabled && (
                          <span
                            style={{
                              marginLeft: 8,
                              fontSize: "var(--fs-secondary)",
                              color: "var(--c-text-5)",
                              fontWeight: 400,
                            }}
                          >
                            暂不支持
                          </span>
                        )}
                      </div>
                      {!card.disabled && (
                        <div
                          style={{
                            fontSize: "var(--fs-secondary)",
                            color: "var(--c-text-4)",
                          }}
                        >
                          {card.desc}
                        </div>
                      )}
                    </div>

                    {/* 单选环 */}
                    {!card.disabled && (
                      <div
                        style={{
                          width: 16,
                          height: 16,
                          borderRadius: "50%",
                          border: isSelected
                            ? "5px solid var(--c-accent)"
                            : "1.5px solid #d4d4d8",
                          flexShrink: 0,
                          background: isSelected ? "var(--c-accent-bg-soft)" : "transparent",
                        }}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Prompt 输入框 */}
          <div style={{ marginBottom: 20 }}>
            <div
              style={{
                fontSize: "var(--fs-secondary)",
                fontWeight: 600,
                color: "var(--c-text-3)",
                marginBottom: 6,
              }}
            >
              初始 Prompt（可选）
            </div>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="描述你想让 agent 做什么…"
              rows={3}
              style={{
                width: "100%",
                padding: "8px 12px",
                border: "1px solid var(--c-border-2)",
                borderRadius: "var(--r-input)",
                background: "var(--c-bg-white)",
                fontSize: "var(--fs-body)",
                color: "var(--c-text-primary)",
                fontFamily: "var(--font-ui)",
                resize: "vertical",
                outline: "none",
                boxSizing: "border-box",
                lineHeight: 1.6,
              }}
            />
          </div>

          {/* 底部按钮行 */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            {/* 左侧 branch·shell 提示 */}
            <span
              style={{
                fontSize: "var(--fs-meta)",
                color: "var(--c-text-5)",
                fontFamily: "var(--font-mono)",
              }}
            >
              ⎇ main · zsh
            </span>

            {/* 右侧按钮组 */}
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={onClose}
                style={{
                  padding: "7px 16px",
                  borderRadius: "var(--r-btn)",
                  border: "1px solid var(--c-border-2)",
                  background: "transparent",
                  color: "var(--c-text-2)",
                  fontSize: "var(--fs-body)",
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                取消
              </button>
              <button
                onClick={handleCreate}
                style={{
                  padding: "7px 16px",
                  borderRadius: "var(--r-btn)",
                  border: "none",
                  background: "#27272a",
                  color: "#fff",
                  fontSize: "var(--fs-body)",
                  fontWeight: 500,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                创建 Agent
                <span
                  style={{
                    fontSize: "var(--fs-secondary)",
                    opacity: 0.7,
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  ⌘⏎
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
