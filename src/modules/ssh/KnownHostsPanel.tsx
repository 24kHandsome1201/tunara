import { useEffect, useState } from "react";
import { useT } from "@/modules/i18n";
import {
  listKnownHostsV1,
  refreshKnownHostsV1,
  removeKnownHostV1,
  type KnownHostsSnapshotV1,
} from "./known-hosts-bridge";
import {
  PanelActionButton,
  PanelEmptyState,
  PanelIconButton,
  PanelLoadingState,
  PanelState,
  PanelToolbar,
} from "@/ui/shared";
import { CaretDown, CaretRight, Icon } from "@/ui/icons";

export function KnownHostsPanel() {
  const t = useT();
  const [snapshot, setSnapshot] = useState<KnownHostsSnapshotV1 | null>(null);
  const [error, setError] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);

  const load = (refresh = false) => {
    setError(false);
    setSnapshot(null);
    void (refresh ? refreshKnownHostsV1() : listKnownHostsV1())
      .then(setSnapshot)
      .catch(() => setError(true));
  };

  useEffect(() => {
    void listKnownHostsV1().then(setSnapshot).catch(() => setError(true));
  }, []);

  return (
    <section role="region" aria-labelledby="known-hosts-title" style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <PanelToolbar
        titleId="known-hosts-title"
        title={snapshot ? t("known_hosts.count", { count: snapshot.entries.length }) : t("known_hosts.title")}
      >
        {expanded && <PanelActionButton onClick={() => load(true)}>{t("known_hosts.refresh")}</PanelActionButton>}
        <PanelIconButton
          aria-expanded={expanded}
          aria-controls="known-hosts-content"
          aria-label={expanded ? t("known_hosts.collapse") : t("known_hosts.expand")}
          title={expanded ? t("known_hosts.collapse") : t("known_hosts.expand")}
          onClick={() => setExpanded((value) => !value)}
        >
          <Icon icon={expanded ? CaretDown : CaretRight} size={12} weight="bold" />
        </PanelIconButton>
      </PanelToolbar>
      {expanded && (
        <div id="known-hosts-content">
          {!snapshot && !error && <PanelLoadingState label={t("known_hosts.loading")} />}
          {error && <PanelState state={{ kind: "error", label: t("known_hosts.failed"), detail: t("known_hosts.failed_hint") }} />}
          {snapshot?.entries.length === 0 && <PanelEmptyState label={t("known_hosts.empty")} sublabel={t("known_hosts.empty_hint")} />}
          {snapshot && snapshot.entries.length > 0 && (
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
              {snapshot.entries.map((entry) => (
                <li key={entry.entryId} style={{ padding: 9, border: "1px solid var(--c-border-1)", borderRadius: "var(--r-card)", background: "var(--c-bg-1)", display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 6 }}>
                  <div style={{ color: "var(--c-text-3)", fontSize: "var(--fs-secondary)", overflowWrap: "anywhere" }}><strong>{entry.patternDisplay}</strong> · {entry.keyType}</div>
                  <code style={{ maxWidth: "100%", color: "var(--c-text-5)", fontSize: "var(--fs-meta)", overflowWrap: "anywhere" }}>{entry.fingerprint}</code>
                  <PanelActionButton
                    disabled={!entry.manageable}
                    aria-label={pendingRemove === entry.entryId
                      ? t("known_hosts.confirm_remove_item", { host: entry.patternDisplay })
                      : t("known_hosts.remove_item", { host: entry.patternDisplay })}
                    onClick={() => {
                      if (pendingRemove !== entry.entryId) {
                        setPendingRemove(entry.entryId);
                        return;
                      }
                      setPendingRemove(null);
                      void removeKnownHostV1(snapshot.revision, entry.entryId)
                        .then(setSnapshot)
                        .catch(() => setError(true));
                    }}
                  >
                    {pendingRemove === entry.entryId ? t("known_hosts.confirm_remove") : t("known_hosts.remove")}
                  </PanelActionButton>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
