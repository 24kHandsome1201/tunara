import type { Session } from "./types";
import { useSessionsStore } from "@/state/sessions";
import { useT } from "@/modules/i18n";
import { SESSION_MASCOTS, SessionMascotIcon } from "./SessionMascotIcon";
import type { CSSProperties } from "react";

function pickerButtonStyle(selected: boolean): CSSProperties {
  return {
    width: 36,
    height: 36,
    borderRadius: "var(--r-btn)",
    border: `1px solid ${selected ? "var(--c-accent)" : "var(--c-border-1)"}`,
    background: selected ? "var(--c-accent-bg-soft)" : "var(--c-bg-2)",
    display: "grid",
    placeItems: "center",
    cursor: "pointer",
    padding: 0,
    transition: "background var(--duration-fast) var(--ease-smooth), border-color var(--duration-fast) var(--ease-smooth), transform var(--duration-fast) var(--ease-out-expo)",
  };
}

export function SessionMascotPicker({ session }: { session: Session }) {
  const t = useT();
  const choose = (mascot: Session["mascot"]) => {
    useSessionsStore.getState().updateSession(session.id, { mascot });
  };

  return (
    <div
      data-session-mascot-picker={session.id}
      style={{ marginBottom: 12, border: "1px solid var(--c-border-1)", borderRadius: "var(--r-card)", background: "var(--c-bg-white)", padding: 12 }}
    >
      <div style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", marginBottom: 3 }}>
        {t("mascot.title")}
      </div>
      <div style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-6)", marginBottom: 9 }}>
        {t("mascot.hint")}
      </div>
      <div role="group" aria-label={t("mascot.title")} style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
        <button
          type="button"
          aria-pressed={!session.mascot}
          title={t("mascot.none")}
          onClick={() => choose(undefined)}
          className="hover-bg"
          style={{ ...pickerButtonStyle(!session.mascot), color: "var(--c-text-5)" }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
        </button>
        {SESSION_MASCOTS.map((mascot) => {
          const selected = session.mascot === mascot.id;
          return (
            <button
              key={mascot.id}
              type="button"
              aria-pressed={selected}
              aria-label={t(mascot.labelKey)}
              title={t(mascot.labelKey)}
              onClick={() => choose(mascot.id)}
              className="hover-bg"
              style={{ ...pickerButtonStyle(selected), padding: 3 }}
            >
              <SessionMascotIcon id={mascot.id} size={28} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
