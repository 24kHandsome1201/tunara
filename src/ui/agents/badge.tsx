import { AGENT_ICONS } from "./icons";

export const AGENT_CIRCLE_STYLES: Record<string, { bg: string; color: string }> = {
  CC: { bg: "#D97706", color: "#ffffff" },
  CX: { bg: "#000000", color: "#ffffff" },
  AM: { bg: "#F34E3F", color: "#ffffff" },
  GM: { bg: "#4285F4", color: "#ffffff" },
  CP: { bg: "#8534F3", color: "#ffffff" },
  CR: { bg: "#26251E", color: "#ffffff" },
  DR: { bg: "#333333", color: "#ffffff" },
  OC: { bg: "#808080", color: "#ffffff" },
  PI: { bg: "#333333", color: "#ffffff" },
  AG: { bg: "#333333", color: "#ffffff" },
  DV: { bg: "#0294DE", color: "#ffffff" },
};

export function AgentBadge({ agent, size = 22, disabled }: { agent?: string; size?: number; disabled?: boolean }) {
  if (!agent) return null;
  const badgeStyle = (code: string): React.CSSProperties => ({
    background: disabled ? "var(--c-bg-3)" : `var(--c-agent-${code}-bg)`,
    border: `1px solid ${disabled ? "var(--c-border-2)" : `var(--c-agent-${code}-border)`}`,
    color: disabled ? "var(--c-text-5)" : `var(--c-agent-${code}-text)`,
  });
  const codeMap: Record<string, string> = {
    CC: "cc", CX: "cx", AM: "am", GM: "gm", CP: "cp", CR: "cr", DR: "dr", OC: "oc", PI: "pi", AG: "ag", DV: "dv",
  };
  const styleMap: Record<string, React.CSSProperties> = Object.fromEntries(
    Object.entries(codeMap).map(([k, v]) => [k, badgeStyle(v)])
  );
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
        ...(styleMap[agent] ?? styleMap.CC),
      }}
    >
      {Icon ? <Icon size={size} /> : <span style={{ fontSize: "var(--fs-badge)", fontWeight: 700, fontFamily: "var(--font-mono)" }}>{agent}</span>}
    </div>
  );
}
