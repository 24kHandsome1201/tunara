// overlays/NewAgent — 新建 Agent 弹层（520px sheet）
// 含：选目录 / Claude Code / ⌘⏎ 创建

import { useState } from "react";
import { type AgentType } from "../types";
import { AgentBadge } from "../SessionCard";

interface NewAgentProps {
  /** 初始选中的 agent */
  initialAgent?: AgentType;
  /** 初始工作目录（默认取当前会话目录） */
  defaultDir?: string;
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
  { id: "CC", name: "Claude Code", desc: "Anthropic 官方 CLI，支持多轮对话与自动写盘" },
  { id: "CX", name: "Codex", desc: "OpenAI CLI agent，支持代码生成与终端操作" },
  { id: "AM", name: "Amp", desc: "Sourcegraph 代码智能 agent，深度代码理解" },
  { id: "GM", name: "Gemini", desc: "Google Gemini CLI，多模态代码理解与生成" },
  { id: "CP", name: "Copilot", desc: "GitHub Copilot CLI，代码建议与终端辅助" },
  { id: "CR", name: "Cursor", desc: "Cursor Agent CLI，智能代码编辑" },
  { id: "DR", name: "Droid", desc: "Droid CLI agent，自动化开发流程" },
  { id: "OC", name: "OpenCode", desc: "OpenCode 终端 agent，开源代码助手" },
  { id: "PI", name: "Pi", desc: "Pi AI agent，对话式编程助手" },
  { id: "AG", name: "Auggie", desc: "Auggie agent，代码审查与修复" },
];


export function NewAgent({ initialAgent = "CC", defaultDir = "~", onClose, onCreate }: NewAgentProps) {
  const [agentPick, setAgentPick] = useState<AgentType>(initialAgent);
  const [dir, setDir] = useState(defaultDir || "~");
  const [prompt, setPrompt] = useState("");

  function handleCreate() {
    if (!prompt.trim() || !dir.trim()) return;
    onCreate(agentPick, dir.trim(), prompt);
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
              }}
            >
              {/* 文件夹图标（琥珀色） */}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--c-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              <input
                value={dir}
                onChange={(e) => setDir(e.target.value)}
                placeholder="~/projects/my-app"
                spellCheck={false}
                style={{
                  flex: 1,
                  border: "none",
                  outline: "none",
                  background: "transparent",
                  fontSize: "var(--fs-body)",
                  fontFamily: "var(--font-mono)",
                  color: "var(--c-text-primary)",
                }}
              />
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
                    <AgentBadge agent={card.id} size={28} disabled={card.disabled} />

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
              初始 Prompt
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
            {/* 左侧目录提示 */}
            <span
              style={{
                fontSize: "var(--fs-meta)",
                color: "var(--c-text-5)",
                fontFamily: "var(--font-mono)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                maxWidth: 220,
              }}
            >
              {dir || "未选择目录"}
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
                disabled={!prompt.trim() || !dir.trim()}
                style={{
                  padding: "7px 16px",
                  borderRadius: "var(--r-btn)",
                  border: "none",
                  background: "#27272a",
                  color: "#fff",
                  fontSize: "var(--fs-body)",
                  fontWeight: 500,
                  cursor: !prompt.trim() || !dir.trim() ? "not-allowed" : "pointer",
                  opacity: !prompt.trim() || !dir.trim() ? 0.4 : 1,
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
