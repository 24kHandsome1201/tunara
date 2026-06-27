import { useEffect, useMemo, useRef, useState } from "react";
import { useUIStore } from "@/state/ui";
import { useSessionsStore } from "@/state/sessions";
import { useT } from "@/modules/i18n";
import { promptableParams, resolveTemplate, type DynamicContext } from "@/modules/workflows/template";
import { useFocusTrap } from "./useFocusTrap";

/**
 * App-level prompt that fills a workflow's {{params}} before running it. Shown
 * when a parameterized workflow is chosen from the command palette. Fully
 * keyboard-drivable: Enter runs, Escape cancels.
 */
export function WorkflowParamPrompt() {
  const t = useT();
  const pending = useUIStore((s) => s.pendingWorkflow);
  const setPendingWorkflow = useUIStore((s) => s.setPendingWorkflow);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef);

  const params = useMemo(() => (pending ? promptableParams(pending.template) : []), [pending]);
  const [values, setValues] = useState<Record<string, string>>({});

  // One stable uuid per opened workflow, so a {{uuid}} placeholder doesn't churn
  // on every keystroke in the live preview (and matches what actually runs).
  const dynamicUuid = useMemo(() => {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    return c?.randomUUID ? c.randomUUID() : `id-${Date.now().toString(36)}`;
  }, [pending]);

  // Reset field values whenever a new workflow is opened, pre-filling any
  // {{name=default}} defaults so the prompt starts from a sensible state.
  useEffect(() => {
    if (pending) {
      const init: Record<string, string> = {};
      for (const p of promptableParams(pending.template)) {
        if (p.default !== undefined) init[p.key] = p.default;
      }
      setValues(init);
      // Focus the first field on open.
      requestAnimationFrame(() => dialogRef.current?.querySelector("input")?.focus());
    } else {
      setValues({});
    }
  }, [pending]);

  if (!pending) return null;

  const ctx: DynamicContext = { cwd: pending.dir, branch: pending.branch ?? "", uuid: () => dynamicUuid };

  const run = () => {
    const command = resolveTemplate(pending.template, values, ctx);
    useSessionsStore.getState().newTerminalWithInput(command, pending.dir);
    setPendingWorkflow(null);
  };

  const preview = resolveTemplate(pending.template, values, ctx);

  const fieldStyle: React.CSSProperties = {
    width: "100%",
    padding: "8px 10px",
    borderRadius: "var(--r-btn)",
    border: "1px solid var(--c-border-2)",
    background: "var(--c-bg-input, var(--c-bg-white))",
    color: "var(--c-text-primary)",
    fontSize: "var(--fs-body)",
    fontFamily: "var(--font-mono)",
    outline: "none",
    boxSizing: "border-box",
  };

  return (
    <>
      <div
        onClick={() => setPendingWorkflow(null)}
        style={{
          position: "fixed",
          inset: 0,
          background: "var(--backdrop-color)",
          backdropFilter: "var(--backdrop-blur)",
          zIndex: 200,
          animation: "fadeIn var(--duration-normal) var(--ease-smooth)",
        }}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        tabIndex={0}
        onKeyDown={(e: React.KeyboardEvent) => {
          if (e.key === "Escape") setPendingWorkflow(null);
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            run();
          }
        }}
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 440,
          maxWidth: "calc(100vw - 32px)",
          background: "var(--c-bg-white)",
          borderRadius: "var(--r-overlay)",
          boxShadow: "var(--shadow-overlay)",
          zIndex: 201,
          animation: "sheetIn var(--duration-normal) var(--ease-out-back)",
          display: "flex",
          flexDirection: "column",
          outline: "none",
        }}
      >
        <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--c-border-2)" }}>
          <span style={{ fontSize: "var(--fs-title)", fontWeight: 600, color: "var(--c-text-primary)" }}>
            {pending.name}
          </span>
        </div>

        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12 }}>
          {params.map((p) => (
            <div key={p.key}>
              <label style={{ display: "block", fontSize: "var(--fs-secondary)", color: "var(--c-text-4)", marginBottom: 4 }}>
                {p.key}
              </label>
              <input
                style={fieldStyle}
                value={values[p.key] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [p.key]: e.target.value }))}
                placeholder={p.default ?? ""}
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
              />
            </div>
          ))}
          <div
            style={{
              padding: "8px 10px",
              borderRadius: "var(--r-btn)",
              background: "var(--c-bg-1)",
              border: "1px solid var(--c-border-2)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--fs-meta)",
              color: "var(--c-text-3)",
              wordBreak: "break-all",
            }}
          >
            {preview}
          </div>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "12px 18px",
            borderTop: "1px solid var(--c-border-2)",
          }}
        >
          <button
            onClick={() => setPendingWorkflow(null)}
            className="hover-bg"
            style={{
              padding: "6px 16px",
              borderRadius: "var(--r-btn)",
              border: "1px solid var(--c-border-2)",
              background: "transparent",
              color: "var(--c-text-primary)",
              fontSize: "var(--fs-body)",
              cursor: "pointer",
            }}
          >
            {t("common.cancel")}
          </button>
          <button
            onClick={run}
            className="hover-primary"
            style={{
              padding: "6px 18px",
              borderRadius: "var(--r-btn)",
              border: "none",
              background: "var(--c-btn-primary-bg)",
              color: "var(--c-btn-primary-text)",
              fontSize: "var(--fs-body)",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            {t("workflow.run")}
          </button>
        </div>
      </div>
    </>
  );
}
