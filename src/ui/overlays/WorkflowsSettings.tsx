import { useState } from "react";
import { useWorkflowsStore } from "@/state/workflows";
import { extractParams, type Workflow } from "@/modules/workflows/template";
import { missingStarterWorkflows } from "@/modules/workflows/starters";
import { useT } from "@/modules/i18n";
import { useDestructiveConfirm } from "../lib/destructive-confirm";
import { CloseIcon } from "../shared";

const SECTION_LABEL: React.CSSProperties = { fontSize: "var(--fs-body)", fontWeight: 600, color: "var(--c-text-3)", marginBottom: 10 };
const SECTION_HINT: React.CSSProperties = { fontSize: "var(--fs-secondary)", color: "var(--c-text-4)", marginTop: 6, lineHeight: 1.5 };

const fieldStyle: React.CSSProperties = {
  width: "100%",
  padding: "7px 10px",
  borderRadius: "var(--r-btn)",
  border: "1px solid var(--c-border-2)",
  background: "var(--c-bg-white)",
  color: "var(--c-text-primary)",
  fontSize: "var(--fs-body)",
  outline: "none",
  boxSizing: "border-box",
};

/** Manage local command-template workflows (add / edit / delete). */
export function WorkflowsSettings() {
  const t = useT();
  const workflows = useWorkflowsStore((s) => s.workflows);
  const upsertWorkflow = useWorkflowsStore((s) => s.upsertWorkflow);
  const removeWorkflow = useWorkflowsStore((s) => s.removeWorkflow);
  const { isPending, tryConfirm } = useDestructiveConfirm();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [template, setTemplate] = useState("");

  const reset = () => {
    setEditingId(null);
    setName("");
    setDescription("");
    setTemplate("");
  };

  const startEdit = (w: Workflow) => {
    setEditingId(w.id);
    setName(w.name);
    setDescription(w.description ?? "");
    setTemplate(w.template);
  };

  const canSave = name.trim().length > 0 && template.trim().length > 0;

  const save = () => {
    if (!canSave) return;
    upsertWorkflow({
      id: editingId ?? undefined,
      name: name.trim(),
      description: description.trim() || undefined,
      template,
    });
    reset();
  };

  const previewParams = extractParams(template).map((p) => p.key);
  const starterWorkflows = missingStarterWorkflows(workflows, t);

  const addStarterWorkflows = () => {
    for (const workflow of starterWorkflows) upsertWorkflow(workflow);
  };

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={SECTION_LABEL}>{t("settings.workflows.title")}</div>
      <div style={SECTION_HINT}>{t("settings.workflows.hint")}</div>

      <div style={{ marginTop: 14, padding: 12, borderRadius: "var(--r-btn)", border: "1px solid var(--c-border-2)", background: "var(--c-bg-1)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: "var(--fs-secondary)", fontWeight: 700, color: "var(--c-text-3)" }}>{t("settings.workflows.starters_title")}</div>
            <div style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-4)", marginTop: 3, lineHeight: 1.45 }}>{t("settings.workflows.starters_hint")}</div>
          </div>
          <button
            onClick={addStarterWorkflows}
            disabled={starterWorkflows.length === 0}
            className="hover-bg"
            style={{ padding: "5px 10px", borderRadius: "var(--r-btn)", border: "1px solid var(--c-border-2)", background: "var(--c-bg-white)", color: starterWorkflows.length === 0 ? "var(--c-text-5)" : "var(--c-text-primary)", fontSize: "var(--fs-secondary)", cursor: starterWorkflows.length === 0 ? "default" : "pointer", flexShrink: 0 }}
          >
            {starterWorkflows.length === 0
              ? t("settings.workflows.starters_all_added")
              : t("settings.workflows.add_starters", { count: starterWorkflows.length })}
          </button>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6, margin: "14px 0" }}>
        {workflows.length === 0 && (
          <div style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-4)", padding: "8px 0" }}>
            {t("settings.workflows.empty")}
          </div>
        )}
        {workflows.map((w) => (
          <div
            key={w.id}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 8,
              padding: "8px 10px",
              borderRadius: "var(--r-btn)",
              border: "1px solid var(--c-border-2)",
              background: editingId === w.id ? "var(--c-bg-1)" : "transparent",
            }}
          >
            <button
              onClick={() => startEdit(w)}
              className="hover-bg"
              style={{ flex: 1, minWidth: 0, textAlign: "left", border: "none", background: "transparent", cursor: "pointer", padding: "2px 4px", borderRadius: "var(--r-btn)" }}
            >
              <div style={{ fontSize: "var(--fs-body)", color: "var(--c-text-primary)", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {w.name}
              </div>
              <div style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-4)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {w.template}
              </div>
            </button>
            <button
              onClick={() => {
                tryConfirm(`workflow:${w.id}`, () => {
                  if (editingId === w.id) reset();
                  removeWorkflow(w.id);
                });
              }}
              title={isPending(`workflow:${w.id}`) ? t("destructive.confirm_again") : t("settings.workflows.delete")}
              aria-label={isPending(`workflow:${w.id}`) ? t("destructive.confirm_again") : t("settings.workflows.delete")}
              className="hover-close"
              style={{ width: 24, height: 24, flexShrink: 0, border: "none", background: "transparent", cursor: "pointer", color: isPending(`workflow:${w.id}`) ? "var(--c-error)" : "var(--c-text-4)", borderRadius: "var(--r-btn)", display: "flex", alignItems: "center", justifyContent: "center" }}
            >
              <CloseIcon />
            </button>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12, borderRadius: "var(--r-btn)", border: "1px solid var(--c-border-2)" }}>
        <div style={{ fontSize: "var(--fs-secondary)", fontWeight: 600, color: "var(--c-text-3)" }}>
          {editingId ? t("settings.workflows.edit") : t("settings.workflows.add")}
        </div>
        <input style={fieldStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("settings.workflows.name_placeholder")} />
        <input style={fieldStyle} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("settings.workflows.desc_placeholder")} />
        <input style={{ ...fieldStyle, fontFamily: "var(--font-mono)" }} value={template} onChange={(e) => setTemplate(e.target.value)} placeholder={t("settings.workflows.template_placeholder")} spellCheck={false} />
        <div style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-4)" }}>
          {previewParams.length > 0
            ? t("settings.workflows.params", { params: previewParams.join(", ") })
            : t("settings.workflows.no_params")}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          {editingId && (
            <button onClick={reset} className="hover-bg" style={{ padding: "5px 14px", borderRadius: "var(--r-btn)", border: "1px solid var(--c-border-2)", background: "transparent", color: "var(--c-text-primary)", fontSize: "var(--fs-secondary)", cursor: "pointer" }}>
              {t("common.cancel")}
            </button>
          )}
          <button
            onClick={save}
            disabled={!canSave}
            className="hover-primary"
            style={{ padding: "5px 16px", borderRadius: "var(--r-btn)", border: "none", background: "var(--c-btn-primary-bg)", color: "var(--c-btn-primary-text)", fontSize: "var(--fs-secondary)", fontWeight: 500, cursor: canSave ? "pointer" : "not-allowed", opacity: canSave ? 1 : 0.5 }}
          >
            {editingId ? t("settings.workflows.save") : t("settings.workflows.add")}
          </button>
        </div>
      </div>
    </div>
  );
}
