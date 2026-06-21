export function RefreshIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 0 1-15.5 6.2" />
      <path d="M3 12A9 9 0 0 1 18.5 5.8" />
      <polyline points="18 2 18.5 5.8 14.8 6.2" />
      <polyline points="6 22 5.5 18.2 9.2 17.8" />
    </svg>
  );
}

export function PanelEmptyState({ icon, label, sublabel }: { icon?: React.ReactNode; label: string; sublabel?: string }) {
  const defaultIcon = (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
  return (
    <div style={{ padding: "28px 14px", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
      <div style={{ width: 36, height: 36, borderRadius: "50%", background: "var(--c-bg-3)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--c-text-5)" }}>
        {icon ?? defaultIcon}
      </div>
      <span style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-4)" }}>{label}</span>
      {sublabel && <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)", maxWidth: "90%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sublabel}</span>}
    </div>
  );
}

export function PanelLoadingState({ label = "加载中" }: { label?: string }) {
  return (
    <div style={{ padding: "28px 14px", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
      <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--c-text-5)", animation: "pulseDot 1.2s ease infinite" }} />
      <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)" }}>{label}</span>
    </div>
  );
}
