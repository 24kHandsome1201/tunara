import { useT } from "@/modules/i18n";

export function SearchRetryButton({ label, onRetry }: { label: string; onRetry: () => void }) {
  return (
    <div style={{ display: "flex", justifyContent: "center", paddingTop: 6 }}>
      <button className="hover-bg" onClick={onRetry} style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-3)", border: "1px solid var(--c-border-1)", borderRadius: "var(--r-btn)", background: "transparent", cursor: "pointer", padding: "2px 10px" }}>{label}</button>
    </div>
  );
}

export function SearchLimitControl({ canLoadMore, loading, onLoadMore }: { canLoadMore: boolean; loading: boolean; onLoadMore: () => void }) {
  const t = useT();
  if (loading) {
    return <div aria-live="polite" style={{ padding: "4px var(--sp-2)", color: "var(--c-text-5)", fontSize: "var(--fs-meta)" }}>{t("explorer.searching")}</div>;
  }
  return canLoadMore ? (
    <button
      type="button"
      onClick={onLoadMore}
      className="hover-bg"
      style={{ margin: "4px var(--sp-2)", padding: "4px 8px", color: "var(--c-accent)", fontSize: "var(--fs-meta)", border: "1px solid var(--c-accent-border)", borderRadius: "var(--r-btn)", background: "var(--c-accent-bg-soft)", cursor: "pointer" }}
    >
      {t("explorer.load_more")}
    </button>
  ) : (
    <div style={{ padding: "4px var(--sp-2)", color: "var(--c-text-5)", fontSize: "var(--fs-meta)" }}>{t("explorer.results_limit_reached")}</div>
  );
}
