import { useMemo, useRef, useState } from "react";
import { useFocusTrap } from "@/ui/overlays/useFocusTrap";
import { performRemoteMutation, type MutationActionResult } from "./actions";
import type { MutationRequestV1 } from "./bridge";
import { useT } from "@/modules/i18n";

export interface RemoteFsMutationDialogProps {
  host: string;
  request: MutationRequestV1;
  onClose: () => void;
  onComplete?: (outcome: MutationActionResult) => void;
}

function operationPaths(request: MutationRequestV1): string[] {
  switch (request.operation.kind) {
    case "rename":
      return [request.operation.sourcePath, request.operation.destinationPath];
    case "mkdir":
    case "delete":
      return [request.operation.path];
  }
}

function operationLabel(request: MutationRequestV1, t: (key: string) => string): string {
  switch (request.operation.kind) {
    case "mkdir": return t("remote_fs.mutation.mkdir");
    case "rename": return t("remote_fs.mutation.rename");
    case "delete": return t("remote_fs.mutation.delete");
  }
}

export function RemoteFsMutationDialog({
  host,
  request,
  onClose,
  onComplete,
}: RemoteFsMutationDialogProps) {
  const t = useT();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<MutationActionResult | null>(null);
  const [error, setError] = useState("");
  useFocusTrap(dialogRef);

  const paths = useMemo(() => operationPaths(request), [request]);
  const sourceKind = request.precondition.source.state === "present"
    ? request.precondition.source.identity.kind
    : t("remote_fs.mutation.absent");
  const destructive = request.operation.kind === "delete"
    || (request.operation.kind === "rename" && request.operation.replace);

  const submit = async () => {
    if (submitting || outcome) return;
    setSubmitting(true);
    setError("");
    try {
      const next = await performRemoteMutation(request);
      setOutcome(next);
      onComplete?.(next);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <div aria-hidden="true" style={{ position: "fixed", inset: 0, background: "var(--backdrop-color)", zIndex: 320 }} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="remote-fs-mutation-title"
        aria-describedby="remote-fs-mutation-safety"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !submitting) onClose();
        }}
        style={{
          position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)",
          width: 520, maxWidth: "calc(100vw - 32px)", background: "var(--c-bg-white)",
          borderRadius: "var(--r-overlay)", boxShadow: "var(--shadow-overlay)", zIndex: 321,
          color: "var(--c-text-primary)", outline: "none", overflow: "hidden",
        }}
      >
        <div style={{ padding: "16px 18px", borderBottom: "1px solid var(--c-border-2)" }}>
          <strong id="remote-fs-mutation-title">{operationLabel(request, t)}</strong>
        </div>
        <div style={{ padding: 18, display: "grid", gap: 12 }}>
          <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "72px 1fr", gap: "7px 10px" }}>
            <dt>{t("remote_fs.mutation.host")}</dt><dd style={{ margin: 0, overflowWrap: "anywhere" }}>{host}</dd>
            <dt>{t("remote_fs.mutation.kind")}</dt><dd style={{ margin: 0 }}>{sourceKind}</dd>
            {paths.map((path, index) => (
              <div key={path} style={{ display: "contents" }}>
                <dt>{index === 0 ? t("remote_fs.mutation.path") : t("remote_fs.mutation.to")}</dt>
                <dd style={{ margin: 0, fontFamily: "var(--font-mono)", overflowWrap: "anywhere" }}>{path}</dd>
              </div>
            ))}
          </dl>
          <p id="remote-fs-mutation-safety" style={{ margin: 0, color: "var(--c-text-4)", lineHeight: 1.5 }}>
            {t("remote_fs.mutation.safety")}
          </p>
          {outcome && (
            <div role="status" style={{ padding: 10, border: "1px solid var(--c-border-2)", borderRadius: "var(--r-btn)" }}>
              <strong>{outcome.result.status}</strong>: {outcome.result.message}
              {outcome.reconciled && t("remote_fs.mutation.reconciled")}
            </div>
          )}
          {error && <div role="alert" style={{ color: "var(--c-error)" }}>{error}</div>}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "12px 18px", borderTop: "1px solid var(--c-border-2)" }}>
          <button type="button" className="ui-button" onClick={onClose} disabled={submitting} autoFocus>
            {outcome ? t("common.close") : t("common.cancel")}
          </button>
          {!outcome && (
            <button
              type="button"
              className={`ui-button ${destructive ? "ui-button--danger" : "ui-button--primary"}`}
              onClick={() => { void submit(); }}
              disabled={submitting}
            >
              {submitting ? t("remote_fs.mutation.checking") : operationLabel(request, t)}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
