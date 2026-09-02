import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type ResolveSource = "userOverride" | "loginShellPath" | "systemPath" | "notFound";
export interface ResolvedCommand {
  name: string;
  path: string | null;
  source: ResolveSource;
}

export interface Preflight {
  installed: boolean;
  loggedIn: boolean;
  hint: string | null;
}

export interface CliStatus {
  resolvedClis: ResolvedCommand[] | null;
  cliError: boolean;
  preflights: Record<string, Preflight>;
  loadCliStatus: () => void;
  applyOverride: (code: string, cliBin: string, path: string) => void;
}

/**
 * CLI resolution state for the settings dialog. Lives in the dialog shell
 * (not the About section) so results survive while the overlay is open:
 * expensive PATH probes run once per dialog opening.
 */
export function useCliStatus(): CliStatus {
  const [resolvedClis, setResolvedClis] = useState<ResolvedCommand[] | null>(null);
  const [cliError, setCliError] = useState(false);
  const [preflights, setPreflights] = useState<Record<string, Preflight>>({});
  const cliLoadStartedRef = useRef(false);

  const loadPreflights = useCallback((items: ResolvedCommand[]) => {
    // Only check login state for CLIs that are actually installed — an auth
    // probe on a missing binary is pointless and slow. Each call is cached
    // 30 min backend-side, so refreshing is cheap.
    const installed = items.filter((cli) => !!cli.path);
    setPreflights({});
    installed.forEach((cli) => {
      invoke<Preflight>("agent_preflight", { agent: cli.name })
        .then((pf) => setPreflights((prev) => ({ ...prev, [cli.name]: pf })))
        .catch(() => {});
    });
  }, []);

  const loadCliStatus = useCallback(() => {
    setResolvedClis(null);
    setCliError(false);
    invoke<ResolvedCommand[]>("resolve_all_bins")
      .then((items) => {
        setResolvedClis(items);
        setCliError(false);
        loadPreflights(items);
      })
      .catch(() => {
        setResolvedClis([]);
        setCliError(true);
      });
  }, [loadPreflights]);

  useEffect(() => {
    if (cliLoadStartedRef.current) return;
    cliLoadStartedRef.current = true;
    loadCliStatus();
  }, [loadCliStatus]);

  const applyOverride = useCallback((code: string, cliBin: string, path: string) => {
    const trimmed = path.trim();
    if (!trimmed) return;
    // The resolver keys overrides by cli_bin (resolve_all_bins resolves cli_bin
    // then relabels name=code), so the override must be stored under cliBin, not
    // the agent code, or it would never take effect. Then invalidate the
    // preflight cache for this agent and re-resolve so the new path + login
    // state show immediately.
    invoke("set_bin_override", { name: cliBin, path: trimmed })
      .then(() => invoke("agent_preflight_invalidate", { agent: code }).catch(() => {}))
      .then(() => loadCliStatus())
      .catch(() => {});
  }, [loadCliStatus]);

  return { resolvedClis, cliError, preflights, loadCliStatus, applyOverride };
}
