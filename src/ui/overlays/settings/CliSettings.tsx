import { useState } from "react";
import { AgentBadge } from "@/ui/agents";
import { AGENT_REGISTRY } from "@/modules/agent/registry";
import { useT } from "@/modules/i18n";
import { RefreshIcon } from "../../shared";
import { SECTION_LABEL } from "./controls";
import type { CliStatus, ResolveSource } from "./useCliStatus";

export const CLI_LIST = AGENT_REGISTRY.map(({ code, name, cliBin }) => ({ code, name, cliBin }));

const SOURCE_LABEL_KEYS: Record<ResolveSource, string> = {
  userOverride: "settings.cli.source.user_override",
  loginShellPath: "settings.cli.source.login_shell_path",
  systemPath: "settings.cli.source.system_path",
  notFound: "settings.cli.source.not_found",
};

/** About: resolved agent CLI paths, login preflights, and path overrides. */
export function CliSettings({ resolvedClis, cliError, preflights, loadCliStatus, applyOverride }: CliStatus) {
  const t = useT();
  const [editingOverride, setEditingOverride] = useState<string | null>(null);
  const [overrideDraft, setOverrideDraft] = useState("");

  const resolvedByCode = new Map((resolvedClis ?? []).map((cli) => [cli.name, cli]));
  const installedCliCount = CLI_LIST.filter(({ code }) => !!resolvedByCode.get(code)?.path).length;

  const saveOverride = (code: string, cliBin: string, path: string) => {
    setEditingOverride(null);
    applyOverride(code, cliBin, path);
  };

  return (
    <div style={{ color: "var(--c-text-4)", fontSize: "var(--fs-body)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ ...SECTION_LABEL, marginBottom: 4 }}>{t("settings.cli.path_label")}</div>
          <div style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)" }}>
            {resolvedClis === null ? t("settings.cli.scanning") : t("settings.cli.found", { count: installedCliCount, total: CLI_LIST.length })}
          </div>
        </div>
        <button
          onClick={loadCliStatus}
          className="hover-bg"
          disabled={resolvedClis === null}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            padding: "5px 9px",
            borderRadius: "var(--r-btn)",
            border: "1px solid var(--c-border-2)",
            background: "var(--c-bg-white)",
            color: "var(--c-text-3)",
            fontSize: "var(--fs-secondary)",
            cursor: resolvedClis === null ? "default" : "pointer",
            opacity: resolvedClis === null ? 0.55 : 1,
            flexShrink: 0,
          }}
        >
          <RefreshIcon size={12} />
          {t("settings.cli.refresh")}
        </button>
      </div>
      {resolvedClis === null && (
        <div style={{ fontSize: "var(--fs-body)", color: "var(--c-text-5)" }}>{t("settings.cli.detecting")}</div>
      )}
      {cliError && (
        <div style={{ fontSize: "var(--fs-body)", color: "var(--c-error)", marginBottom: 10 }}>
          {t("settings.cli.error")}
        </div>
      )}
      {resolvedClis !== null && (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {CLI_LIST.map(({ code, name, cliBin }) => {
            const cli = resolvedByCode.get(code);
            const installed = !!cli?.path;
            const source = cli?.source ?? "notFound";
            const pf = preflights[code];
            const isEditing = editingOverride === code;
            return (
              <div key={code} style={{ padding: "8px 0", borderBottom: "1px solid var(--c-border-1)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <AgentBadge agent={code} size={28} disabled={!installed} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: "var(--fs-body)", fontWeight: 600, color: "var(--c-text-2)" }}>{name}</span>
                      {installed && pf && !pf.loggedIn && (
                        <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-warning)", fontWeight: 600, flexShrink: 0 }}>
                          {t("settings.cli.not_logged_in")}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-4)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 1 }}>
                      {installed ? cli?.path : t("settings.cli.not_on_path")}
                    </div>
                  </div>
                  <span style={{ fontSize: "var(--fs-meta)", color: installed ? "var(--c-success)" : "var(--c-text-5)", fontWeight: 600, flexShrink: 0 }}>
                    {installed ? t(SOURCE_LABEL_KEYS[source]) : t("settings.cli.source.not_found")}
                  </span>
                  <button
                    onClick={() => {
                      setEditingOverride(isEditing ? null : code);
                      setOverrideDraft(cli?.path ?? "");
                    }}
                    className="hover-bg"
                    title={t("settings.cli.override")}
                    aria-label={t("settings.cli.override")}
                    style={{ width: 24, height: 24, borderRadius: "var(--r-btn)", border: "none", background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color: isEditing ? "var(--c-accent)" : "var(--c-text-5)" }}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 20h9" />
                      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
                    </svg>
                  </button>
                </div>
                {isEditing && (
                  <div style={{ display: "flex", gap: 6, marginTop: 8, paddingLeft: 38 }}>
                    <input
                      value={overrideDraft}
                      onChange={(e) => setOverrideDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); saveOverride(code, cliBin, overrideDraft); }
                        else if (e.key === "Escape") { e.preventDefault(); setEditingOverride(null); }
                      }}
                      autoFocus
                      spellCheck={false}
                      placeholder={t("settings.cli.override_placeholder")}
                      style={{ flex: 1, minWidth: 0, height: 30, border: "1px solid var(--c-border-2)", borderRadius: "var(--r-btn)", background: "var(--c-bg-white)", color: "var(--c-text-primary)", padding: "0 10px", fontFamily: "var(--font-mono)", fontSize: "var(--fs-secondary)", outline: "none" }}
                    />
                    <button
                      onClick={() => saveOverride(code, cliBin, overrideDraft)}
                      className="hover-bg"
                      style={{ padding: "0 12px", height: 30, borderRadius: "var(--r-btn)", border: "1px solid var(--c-accent-border)", background: "var(--c-accent-bg-light)", color: "var(--c-accent)", fontSize: "var(--fs-secondary)", fontWeight: 600, cursor: "pointer", flexShrink: 0 }}
                    >
                      {t("settings.cli.override_save")}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
