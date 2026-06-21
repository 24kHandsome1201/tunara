import { AGENT_ICONS } from "./icons";

export const AGENT_CIRCLE_STYLES: Record<string, { bg: string; border: string; color: string }> = {
  CC: { bg: "var(--c-agent-cc-bg)", border: "var(--c-agent-cc-border)", color: "var(--c-agent-cc-text)" },
  CX: { bg: "var(--c-agent-cx-bg)", border: "var(--c-agent-cx-border)", color: "var(--c-agent-cx-text)" },
  AM: { bg: "var(--c-agent-am-bg)", border: "var(--c-agent-am-border)", color: "var(--c-agent-am-text)" },
  GM: { bg: "var(--c-agent-gm-bg)", border: "var(--c-agent-gm-border)", color: "var(--c-agent-gm-text)" },
  CP: { bg: "var(--c-agent-cp-bg)", border: "var(--c-agent-cp-border)", color: "var(--c-agent-cp-text)" },
  CR: { bg: "var(--c-agent-cr-bg)", border: "var(--c-agent-cr-border)", color: "var(--c-agent-cr-text)" },
  DR: { bg: "var(--c-agent-dr-bg)", border: "var(--c-agent-dr-border)", color: "var(--c-agent-dr-text)" },
  OC: { bg: "var(--c-agent-oc-bg)", border: "var(--c-agent-oc-border)", color: "var(--c-agent-oc-text)" },
  PI: { bg: "var(--c-agent-pi-bg)", border: "var(--c-agent-pi-border)", color: "var(--c-agent-pi-text)" },
  AG: { bg: "var(--c-agent-ag-bg)", border: "var(--c-agent-ag-border)", color: "var(--c-agent-ag-text)" },
  DV: { bg: "var(--c-agent-dv-bg)", border: "var(--c-agent-dv-border)", color: "var(--c-agent-dv-text)" },
};

export function AgentBadge({ agent, size = 22, disabled }: { agent?: string; size?: number; disabled?: boolean }) {
  if (!agent) return null;
  const palette = disabled
    ? { bg: "var(--c-bg-3)", border: "var(--c-border-2)", color: "var(--c-text-5)" }
    : (AGENT_CIRCLE_STYLES[agent] ?? AGENT_CIRCLE_STYLES.CC);
  const Icon = AGENT_ICONS[agent];

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "var(--r-badge)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        color: palette.color,
      }}
    >
      {Icon ? <Icon size={size} /> : <span style={{ fontSize: "var(--fs-badge)", fontWeight: 700, fontFamily: "var(--font-mono)" }}>{agent}</span>}
    </div>
  );
}
