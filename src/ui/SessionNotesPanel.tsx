import { useEffect, useMemo, useState } from "react";
import { type Session } from "./types";
import { useSessionsStore } from "@/state/sessions";
import { appendSessionNoteBlock, getSessionNoteStats, sanitizeSessionNote } from "@/modules/session/session-notes";
import { useT } from "@/modules/i18n";

interface SessionNotesPanelProps {
  session: Session;
}

type TemplateKind = "daily" | "commit" | "bug" | "duck";

const TEMPLATE_KINDS: TemplateKind[] = ["daily", "commit", "bug", "duck"];

export function SessionNotesPanel({ session }: SessionNotesPanelProps) {
  const t = useT();
  const setSessionNote = useSessionsStore((s) => s.setSessionNote);
  const [value, setValue] = useState(session.note ?? "");
  const stats = useMemo(() => getSessionNoteStats(value), [value]);

  useEffect(() => {
    setValue(session.note ?? "");
  }, [session.id]);

  useEffect(() => {
    const current = session.note ?? "";
    if (value === current) return;
    const timer = setTimeout(() => setSessionNote(session.id, value), 350);
    return () => clearTimeout(timer);
  }, [session.id, session.note, setSessionNote, value]);

  const flush = () => {
    setSessionNote(session.id, value);
  };

  const addTemplate = (kind: TemplateKind) => {
    const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date());
    const block = t(`notes.template.${kind}.block`, { date });
    setValue((prev) => appendSessionNoteBlock(prev, block));
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", padding: 14, gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {TEMPLATE_KINDS.map((kind) => (
          <button
            key={kind}
            onClick={() => addTemplate(kind)}
            className="hover-bg"
            style={{
              height: 28,
              border: "1px solid var(--c-border-1)",
              borderRadius: "var(--r-pill)",
              background: "var(--c-bg-white)",
              color: "var(--c-text-primary)",
              cursor: "pointer",
              padding: "0 10px",
              fontSize: "var(--fs-secondary)",
              fontWeight: 600,
            }}
          >
            {t(`notes.template.${kind}.label`)}
          </button>
        ))}
        <span style={{ marginLeft: "auto", fontSize: "var(--fs-meta)", color: "var(--c-text-5)", whiteSpace: "nowrap" }}>
          {t("notes.stats", {
            chars: String(stats.chars),
            done: String(stats.doneCount),
            total: String(stats.todoCount),
          })}
        </span>
      </div>

      <textarea
        value={value}
        onChange={(e) => setValue(sanitizeSessionNote(e.target.value))}
        onBlur={flush}
        placeholder={t("notes.placeholder")}
        spellCheck
        style={{
          flex: 1,
          minHeight: 0,
          resize: "none",
          border: "1px solid var(--c-border-1)",
          borderRadius: "var(--r-card)",
          background: "var(--c-bg-white)",
          color: "var(--c-text-primary)",
          outline: "none",
          padding: 12,
          fontFamily: "var(--font-mono)",
          fontSize: "var(--fs-secondary)",
          lineHeight: 1.55,
          boxShadow: "var(--shadow-card)",
        }}
      />

      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "var(--fs-meta)", color: "var(--c-text-5)" }}>
        <span>{t("notes.save_hint")}</span>
        <span style={{ flex: 1 }} />
        <button
          onClick={() => setValue("")}
          className="hover-text-3"
          style={{ border: "none", background: "transparent", color: "var(--c-text-5)", cursor: "pointer", fontSize: "var(--fs-meta)" }}
        >
          {t("notes.clear")}
        </button>
        <button
          onClick={() => navigator.clipboard?.writeText(value).catch(() => {})}
          className="hover-text-3"
          style={{ border: "none", background: "transparent", color: "var(--c-text-5)", cursor: "pointer", fontSize: "var(--fs-meta)" }}
        >
          {t("notes.copy")}
        </button>
      </div>
    </div>
  );
}
