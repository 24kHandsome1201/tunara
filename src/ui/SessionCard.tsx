// SessionCard — 侧边栏会话卡片
// 展示 agent 角标、标题、branch/状态/时长 meta 行、运行中进度条

import { type Session, type SessionStatus, deriveStatus, deriveDuration } from "./types";

interface SessionCardProps {
  session: Session;
  active: boolean;
  onClick: () => void;
}

/** 22×22 agent 角标，按 CC/CX/CU 三种配色 */
export function AgentBadge({ agent, size = 22, disabled }: { agent?: "CC" | "CX" | "CU"; size?: number; disabled?: boolean }) {
  if (!agent) return null;
  const styles: Record<"CC" | "CX" | "CU", React.CSSProperties> = {
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
        width: size,
        height: size,
        borderRadius: "var(--r-badge)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: "var(--fs-badge)",
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

/** 状态点/勾：运行中(橘+呼吸)/刚完成(绿勾)/done(灰点) */
function StatusIndicator({ status }: { status: SessionStatus }) {
  if (status === "running") {
    return (
      <span
        style={{
          display: "inline-block",
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: "var(--c-accent)",
          flexShrink: 0,
          animation: "pulseDot 1.3s ease-in-out infinite",
        }}
      />
    );
  }
  if (status === "fresh") {
    return (
      <span style={{ color: "var(--c-success)", fontSize: 10, flexShrink: 0 }}>✓</span>
    );
  }
  // done
  return (
    <span
      style={{
        display: "inline-block",
        width: 5,
        height: 5,
        borderRadius: "50%",
        background: "#9aa0a6",
        flexShrink: 0,
      }}
    />
  );
}

/** 状态文字标签 */
function StatusLabel({ status }: { status: SessionStatus }) {
  if (status === "running") {
    return (
      <span
        style={{
          fontSize: "var(--fs-meta-sm)",
          color: "var(--c-accent)",
          fontWeight: 600,
          flexShrink: 0,
        }}
      >
        运行中
      </span>
    );
  }
  if (status === "fresh") {
    return (
      <span
        style={{
          fontSize: "var(--fs-meta-sm)",
          color: "var(--c-success)",
          fontWeight: 600,
          flexShrink: 0,
        }}
      >
        已完成
      </span>
    );
  }
  return (
    <span
      style={{
        fontSize: "var(--fs-meta-sm)",
        color: "#9aa0a6",
        flexShrink: 0,
      }}
    >
      exit 0
    </span>
  );
}

export function SessionCard({ session, active, onClick }: SessionCardProps) {
  const status = deriveStatus(session);
  const duration = deriveDuration(session);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => e.key === "Enter" && onClick()}
      style={{
        position: "relative",
        padding: "var(--sp-card-pad)",
        borderRadius: "var(--r-card)",
        cursor: "pointer",
        userSelect: "none",
        background: active ? "var(--c-bg-white)" : "transparent",
        border: active ? "1px solid var(--c-border-2)" : "1px solid transparent",
        boxShadow: active ? "var(--shadow-card)" : "none",
        outline: "none",
      }}
    >
      {/* 激活态左边 3px 橘色条 */}
      {active && (
        <div
          style={{
            position: "absolute",
            left: 0,
            top: "50%",
            transform: "translateY(-50%)",
            width: 3,
            height: "60%",
            minHeight: 20,
            background: "var(--c-accent)",
            borderRadius: "0 2px 2px 0",
          }}
        />
      )}

      {/* 行1：角标 + 标题 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          marginBottom: 5,
        }}
      >
        <AgentBadge agent={session.agent} />
        <span
          style={{
            fontSize: "var(--fs-body)",
            fontWeight: 600,
            color: "var(--c-text-primary)",
            flex: 1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {session.title}
        </span>
      </div>

      {/* 行2：meta — branch + 状态 + 时长 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          overflow: "hidden",
        }}
      >
        <span
          style={{
            fontSize: "var(--fs-meta-sm)",
            color: "var(--c-text-5)",
            fontFamily: "var(--font-mono)",
            flexShrink: 0,
            whiteSpace: "nowrap",
          }}
        >
          ⎇ {session.branch}
        </span>
        <StatusIndicator status={status} />
        <StatusLabel status={status} />
        <span
          style={{
            fontSize: "var(--fs-meta-sm)",
            color: "var(--c-text-5)",
            marginLeft: "auto",
            flexShrink: 0,
            whiteSpace: "nowrap",
          }}
        >
          {duration}
        </span>
      </div>

      {/* 运行中不定进度条 */}
      {status === "running" && (
        <div
          style={{
            marginTop: 6,
            height: 3,
            borderRadius: 2,
            background: "#f0eae6",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: "40%",
              background: "var(--c-accent)",
              borderRadius: 2,
              animation: "indeterminate 1.4s ease-in-out infinite",
            }}
          />
        </div>
      )}
    </div>
  );
}

