import type { SessionBindingV1 } from "@/modules/terminal/lib/pty-bridge";
import type { InspectorTab } from "@/state/ui";
import type { Session } from "./types";

export type InspectorScope = "global" | "profile" | "logical-session" | "transport-binding";

export interface InspectorTabDescriptor {
  id: InspectorTab;
  scope: InspectorScope;
  titleKey: string;
  descriptionKey: string;
}

export interface InspectorScopeContext {
  kind: InspectorScope;
  /** Stable identity for remounting and rejecting late asynchronous results. */
  key: string;
  logicalSessionId?: string;
  profileId?: string;
  binding?: SessionBindingV1;
}

export interface InspectorScopedPanelProps {
  inspectorScope: InspectorScopeContext;
}

export const INSPECTOR_TAB_DESCRIPTORS: Record<InspectorTab, InspectorTabDescriptor> = {
  overview: { id: "overview", scope: "logical-session", titleKey: "inspector.tab.overview", descriptionKey: "inspector.scope.description.logical_session" },
  changes: { id: "changes", scope: "profile", titleKey: "diff.title", descriptionKey: "inspector.scope.description.profile" },
  files: { id: "files", scope: "transport-binding", titleKey: "inspector.tab.files", descriptionKey: "inspector.scope.description.transport_binding" },
  transfers: { id: "transfers", scope: "logical-session", titleKey: "inspector.tab.transfers", descriptionKey: "inspector.scope.description.logical_session" },
  metadata: { id: "metadata", scope: "transport-binding", titleKey: "inspector.tab.metadata", descriptionKey: "inspector.scope.description.transport_binding" },
  forwarding: { id: "forwarding", scope: "transport-binding", titleKey: "inspector.tab.forwarding", descriptionKey: "inspector.scope.description.transport_binding" },
  diagnostics: { id: "diagnostics", scope: "logical-session", titleKey: "inspector.tab.diagnostics", descriptionKey: "inspector.scope.description.logical_session" },
  knownHosts: { id: "knownHosts", scope: "global", titleKey: "inspector.tab.known_hosts", descriptionKey: "inspector.scope.description.global" },
  preview: { id: "preview", scope: "logical-session", titleKey: "inspector.tab.preview", descriptionKey: "inspector.scope.description.logical_session" },
  notes: { id: "notes", scope: "logical-session", titleKey: "inspector.tab.notes", descriptionKey: "inspector.scope.description.logical_session" },
};

export function bindingIdentity(binding: SessionBindingV1 | null): string | null {
  return binding
    ? `${binding.logicalSessionId}\0${binding.physicalPtyId}\0${binding.transportGeneration}`
    : null;
}

export function resolveInspectorScope(
  descriptor: InspectorTabDescriptor,
  session: Session,
  binding: SessionBindingV1 | null,
): InspectorScopeContext {
  const profileId = session.workspace?.repository.id
    ?? (session.remote
      ? `${session.remote.user}@${session.remote.host}:${session.remote.port}`
      : `unresolved:${session.id}`);
  if (descriptor.scope === "global") return { kind: "global", key: "global" };
  if (descriptor.scope === "profile") {
    return { kind: "profile", key: `profile:${profileId}`, profileId };
  }
  if (descriptor.scope === "transport-binding" && binding) {
    return {
      kind: "transport-binding",
      key: `binding:${bindingIdentity(binding)}`,
      logicalSessionId: session.id,
      profileId,
      binding,
    };
  }
  return {
    kind: "logical-session",
    key: `session:${session.id}`,
    logicalSessionId: session.id,
    profileId,
  };
}

/**
 * Minimal async epoch guard for panels which remain mounted while their scope
 * changes. Capture a ticket before awaiting and apply a result only if current.
 */
export class InspectorScopeEpoch {
  #scopeKey: string;
  #epoch = 0;

  constructor(scopeKey: string) {
    this.#scopeKey = scopeKey;
  }

  switchScope(scopeKey: string): void {
    if (scopeKey === this.#scopeKey) return;
    this.#scopeKey = scopeKey;
    this.#epoch += 1;
  }

  capture(): { scopeKey: string; epoch: number } {
    return { scopeKey: this.#scopeKey, epoch: this.#epoch };
  }

  isCurrent(ticket: { scopeKey: string; epoch: number }): boolean {
    return ticket.scopeKey === this.#scopeKey && ticket.epoch === this.#epoch;
  }

  invalidate(): void {
    this.#epoch += 1;
  }
}
