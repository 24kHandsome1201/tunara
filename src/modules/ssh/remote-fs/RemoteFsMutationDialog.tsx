import { useMemo, useState } from "react";
import {
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  MODAL_COLUMN_LAYOUT,
} from "@/ui/overlays/Modal";
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
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<MutationActionResult | null>(null);
  const [error, setError] = useState("");

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
    <Modal
      labelledBy="remote-fs-mutation-title"
      describedBy="remote-fs-mutation-safety"
      onRequestClose={() => { if (!submitting) onClose(); }}
      closeOnBackdrop={false}
      style={{
        ...MODAL_COLUMN_LAYOUT,
        width: 520,
        maxWidth: "calc(100vw - 32px)",
        color: "var(--c-text-primary)",
      }}
    >
      <ModalHeader>
        <ModalTitle id="remote-fs-mutation-title">{operationLabel(request, t)}</ModalTitle>
      </ModalHeader>
      <ModalBody>
        <dl style={{ margin: 0, display: "grid", gridTemplateColumns: "72px 1fr", gap: "7px 10px" }}>
          <dt>{t("common.host")}</dt><dd style={{ margin: 0, overflowWrap: "anywhere" }}>{host}</dd>
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
      </ModalBody>
      <ModalFooter>
        <button type="button" className="ui-button" onClick={onClose} disabled={submitting}>
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
      </ModalFooter>
    </Modal>
  );
}
