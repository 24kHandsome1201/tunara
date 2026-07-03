import { useEffect, useMemo, useRef, useState } from "react";
import { type Session } from "./types";
import { useSessionsStore } from "@/state/sessions";
import { getSessionNoteStats, sanitizeSessionNote } from "@/modules/session/session-notes";
import { copyText } from "./lib/clipboard";
import { useT } from "@/modules/i18n";

interface SessionNotesPanelProps {
  session: Session;
}

export function SessionNotesPanel({ session }: SessionNotesPanelProps) {
  const t = useT();
  const setSessionNote = useSessionsStore((s) => s.setSessionNote);
  const [value, setValue] = useState(session.note ?? "");
  const stats = useMemo(() => getSessionNoteStats(value), [value]);
  // Last USER edit (not last render): written only by handleEdit, so when the
  // session switches, this still holds the previous session's unsaved text at
  // the moment the old effect's cleanup runs — render has already re-executed
  // with the new session by then, which is why a render-synced ref can't work
  // here.
  const lastEditRef = useRef<{ sessionId: string; value: string } | null>(null);

  const handleEdit = (next: string) => {
    lastEditRef.current = { sessionId: session.id, value: next };
    setValue(next);
  };

  useEffect(() => {
    // Read the note from the store (same source as the prop) so this effect
    // genuinely depends on session.id alone.
    setValue(useSessionsStore.getState().sessions.find((s) => s.id === session.id)?.note ?? "");
    // A pending edit for a DIFFERENT session was flushed by the cleanup below;
    // drop it so it can never be re-applied to this session.
    if (lastEditRef.current && lastEditRef.current.sessionId !== session.id) {
      lastEditRef.current = null;
    }
    return () => {
      // Switching sessions (or unmounting) inside the 350 ms save window used
      // to drop the last keystrokes: the debounce cleanup cleared the timer
      // and nothing re-flushed for the OLD session. Persist the pending edit
      // this effect instance owns; setSessionNote no-ops on identical values,
      // so an already-saved edit costs nothing.
      const pending = lastEditRef.current;
      if (pending && pending.sessionId === session.id) {
        useSessionsStore.getState().setSessionNote(pending.sessionId, pending.value);
      }
    };
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

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", padding: 14, gap: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
        onChange={(e) => handleEdit(sanitizeSessionNote(e.target.value))}
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
          onClick={() => handleEdit("")}
          className="hover-text-3"
          style={{ border: "none", background: "transparent", color: "var(--c-text-5)", cursor: "pointer", fontSize: "var(--fs-meta)" }}
        >
          {t("notes.clear")}
        </button>
        <button
          onClick={() => void copyText(value)}
          className="hover-text-3"
          style={{ border: "none", background: "transparent", color: "var(--c-text-5)", cursor: "pointer", fontSize: "var(--fs-meta)" }}
        >
          {t("notes.copy")}
        </button>
      </div>
    </div>
  );
}
