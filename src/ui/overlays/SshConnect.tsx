import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSessionsStore, createRemoteSession } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { CloseIcon, SearchIcon } from "../shared";
import { useT } from "@/modules/i18n";
import {
  loadHosts,
  saveHost,
  removeHost,
  makeHostId,
  normalizeSshPort,
  parseSshPort,
  importSshConfig,
  type SshAuthMethod,
  type SshHostProfile,
} from "@/modules/ssh/hosts-bridge";
import { hasLiveSshPty, stashSshCredentials, stashSshReconnect, takeSshCredentials, takeSshReconnect } from "@/modules/ssh/pending-credentials";
import type { RemoteInfo } from "../types";
import { useFocusTrap } from "./useFocusTrap";
import { useDestructiveConfirm } from "../lib/destructive-confirm";

interface SshConnectProps {
  onClose: () => void;
}

const AUTH_METHODS: SshAuthMethod[] = ["agent", "key", "password", "keyboard-interactive"];

const fieldStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: "var(--r-btn)",
  border: "1px solid var(--c-border-2)",
  background: "var(--c-bg-input, var(--c-bg-white))",
  color: "var(--c-text-primary)",
  fontSize: "var(--fs-body)",
  outline: "none",
  boxSizing: "border-box",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "var(--fs-secondary)",
  color: "var(--c-text-4)",
  marginBottom: 4,
};

function profileMatches(profile: SshHostProfile, query: string): boolean {
  if (!query) return true;
  const haystack = `${profile.label} ${profile.user}@${profile.host}:${profile.port}`.toLowerCase();
  return haystack.includes(query);
}

function ProfileRow({
  profile,
  source,
  onSelect,
  onDelete,
  deletePending,
}: {
  profile: SshHostProfile;
  source: "saved" | "config";
  onSelect: () => void;
  onDelete?: () => void;
  deletePending?: boolean;
}) {
  const t = useT();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, borderRadius: "var(--r-btn)" }}>
      <button
        type="button"
        onClick={onSelect}
        className="hover-bg"
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "7px 8px",
          border: "none",
          borderRadius: "var(--r-btn)",
          background: "transparent",
          color: "var(--c-text-primary)",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "var(--fs-body)", fontWeight: 550 }}>
          {profile.label || `${profile.user}@${profile.host}`}
        </span>
        <span style={{ color: "var(--c-text-5)", fontFamily: "var(--font-mono)", fontSize: "var(--fs-meta)", whiteSpace: "nowrap" }}>
          {profile.user ? `${profile.user}@` : ""}{profile.host}{profile.port !== 22 ? `:${profile.port}` : ""}
        </span>
        <span style={{ color: "var(--c-text-5)", fontSize: "var(--fs-meta)", whiteSpace: "nowrap" }}>
          {source === "config" ? "~/.ssh/config" : profile.authMethod ? t(`ssh.auth.${profile.authMethod}.short`) : t("ssh.auth.choose.short")}
        </span>
      </button>
      {onDelete && (
        <button
          type="button"
          onClick={onDelete}
          title={deletePending ? t("destructive.confirm_again") : t("ssh.profile.delete")}
          aria-label={deletePending ? t("destructive.confirm_again") : t("ssh.profile.delete")}
          className="hover-close"
          style={{ width: 24, height: 24, flexShrink: 0, border: "none", background: "transparent", cursor: "pointer", color: deletePending ? "var(--c-error)" : "var(--c-text-4)", borderRadius: "var(--r-btn)", display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <CloseIcon />
        </button>
      )}
    </div>
  );
}

/** Compact macOS connection sheet. Authentication is an explicit strategy,
 * never a fallback chain; secrets remain one-shot in memory. */
export function SshConnect({ onClose }: SshConnectProps) {
  const t = useT();
  const { isPending, tryConfirm } = useDestructiveConfirm();
  const containerRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLInputElement>(null);
  const addSession = useSessionsStore((s) => s.addSession);
  const setOverlay = useUIStore((s) => s.setOverlay);
  const prefill = useUIStore.getState().sshPrefill;

  const [host, setHost] = useState(prefill?.host ?? "");
  const [port, setPort] = useState(prefill?.port ? String(prefill.port) : "22");
  const [user, setUser] = useState(prefill?.user ?? "");
  const [authMethod, setAuthMethod] = useState<SshAuthMethod | undefined>(prefill?.authMethod);
  const [identityFile, setIdentityFile] = useState(prefill?.identityFile ?? "");
  const [keyPassphrase, setKeyPassphrase] = useState("");
  const [password, setPassword] = useState("");
  const [saveProfile, setSaveProfile] = useState(false);
  const [injectIntegration, setInjectIntegration] = useState(prefill?.injectShellIntegration ?? true);
  const [hosts, setHosts] = useState<SshHostProfile[]>([]);
  const [configHosts, setConfigHosts] = useState<SshHostProfile[]>([]);
  const [configSkipped, setConfigSkipped] = useState(0);
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [query, setQuery] = useState("");

  useFocusTrap(containerRef);

  useEffect(() => {
    (prefill?.host ? hostRef : containerRef).current?.querySelector?.("input")?.focus();
    if (prefill?.host) hostRef.current?.focus();
  }, [prefill?.host]);

  useEffect(() => {
    loadHosts()
      .then(setHosts)
      .catch(() => {
        setHosts([]);
        useUIStore.getState().addToast({ title: t("ssh.profile.load_failed"), subtitle: "", variant: "error" });
      });
  }, [t]);

  const refreshConfig = async (announce: boolean) => {
    if (loadingConfig) return;
    setLoadingConfig(true);
    try {
      const result = await importSshConfig();
      setConfigHosts(result.imported);
      setConfigSkipped(result.skipped);
      if (announce) {
        useUIStore.getState().addToast({
          title: t("ssh.config.loaded"),
          subtitle: t("ssh.config.loaded_detail", { available: result.imported.length, skipped: result.skipped }),
          variant: "success",
        });
      }
    } catch {
      setConfigHosts([]);
      if (announce) {
        useUIStore.getState().addToast({ title: t("ssh.config.load_failed"), subtitle: "", variant: "error" });
      }
    } finally {
      setLoadingConfig(false);
    }
  };

  useEffect(() => {
    void refreshConfig(false);
    // Read-only source is refreshed for each sheet opening, not copied into
    // Tunara profiles. The button below lets users refresh while it stays open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fillFrom = (profile: SshHostProfile) => {
    setHost(profile.host);
    setPort(String(profile.port));
    setUser(profile.user);
    setAuthMethod(profile.authMethod);
    setIdentityFile(profile.authMethod === "key" || !profile.authMethod ? profile.identityFile : "");
    setPassword("");
    setKeyPassphrase("");
    requestAnimationFrame(() => hostRef.current?.focus());
  };

  const deleteProfile = (id: string) => {
    tryConfirm(`ssh-profile:${id}`, () => {
      removeHost(id)
        .then(setHosts)
        .catch(() => useUIStore.getState().addToast({ title: t("ssh.profile.remove_failed"), subtitle: "", variant: "error" }));
    });
  };

  const chooseAuthMethod = (method: SshAuthMethod) => {
    setAuthMethod(method);
    if (method !== "password") setPassword("");
    if (method !== "key") {
      setIdentityFile("");
      setKeyPassphrase("");
    }
  };

  const chooseIdentityFile = async () => {
    try {
      const selected = await open({
        directory: false,
        multiple: false,
        title: t("ssh.identity_picker.title"),
        defaultPath: identityFile.trim() || undefined,
      });
      if (typeof selected === "string") setIdentityFile(selected);
    } catch {
      useUIStore.getState().addToast({ title: t("ssh.identity_picker.failed"), subtitle: "", variant: "error" });
    }
  };

  const normalizedQuery = query.trim().toLowerCase();
  const filteredHosts = useMemo(() => hosts.filter((profile) => profileMatches(profile, normalizedQuery)), [hosts, normalizedQuery]);
  const filteredConfigHosts = useMemo(() => configHosts.filter((profile) => profileMatches(profile, normalizedQuery)), [configHosts, normalizedQuery]);
  const hasSources = hosts.length > 0 || configHosts.length > 0;
  const portText = port.trim();
  const portInvalid = portText.length > 0 && parseSshPort(portText) === null;
  const methodReady = authMethod === "key"
    ? identityFile.trim().length > 0
    : authMethod === "password"
      ? password.length > 0
      : authMethod !== undefined;
  const canConnect = host.trim().length > 0
    && user.trim().length > 0
    && (portText.length === 0 || parseSshPort(portText) !== null)
    && methodReady;

  const connect = () => {
    if (!canConnect || !authMethod) return;
    const safePort = normalizeSshPort(port);
    const trimmedHost = host.trim();
    const trimmedUser = user.trim();
    const trimmedId = authMethod === "key" ? identityFile.trim() : "";

    if (saveProfile) {
      const existing = hosts.find((candidate) =>
        candidate.host === trimmedHost && candidate.port === safePort && candidate.user === trimmedUser
      );
      void saveHost({
        id: existing?.id ?? makeHostId(),
        label: existing?.label ?? `${trimmedUser}@${trimmedHost}`,
        host: trimmedHost,
        port: safePort,
        user: trimmedUser,
        authMethod,
        identityFile: trimmedId,
      }).catch(() => useUIStore.getState().addToast({ title: t("ssh.profile.save_failed"), subtitle: "", variant: "error" }));
    }

    const remote: RemoteInfo = {
      host: trimmedHost,
      port: safePort,
      user: trimmedUser,
      authMethod,
      ...(authMethod === "key" && trimmedId ? { identityFile: trimmedId } : {}),
      injectShellIntegration: injectIntegration,
    };
    const reconnectSessionId = prefill?.reconnectSessionId;
    const existingSession = reconnectSessionId
      ? useSessionsStore.getState().sessions.find((session) => session.id === reconnectSessionId)
      : undefined;
    const session = existingSession?.remote ? existingSession : createRemoteSession(remote);

    stashSshCredentials(session.id, {
      password: authMethod === "password" ? password : undefined,
      keyPassphrase: authMethod === "key" ? keyPassphrase || undefined : undefined,
    });
    setPassword("");
    setKeyPassphrase("");

    if (existingSession?.remote) {
      const reconnectNonce = (existingSession.reconnectNonce ?? 0) + 1;
      if (hasLiveSshPty(existingSession)) {
        // Keep the mounted terminal and its published PTY alive until the
        // candidate authenticates and the backend atomically publishes it.
        stashSshReconnect(existingSession.id, {
          remote,
          credentials: takeSshCredentials(existingSession.id) ?? {},
        });
        useSessionsStore.getState().updateSession(existingSession.id, {
          reconnectNonce,
          terminalMountNonce: existingSession.terminalMountNonce ?? existingSession.reconnectNonce ?? 0,
        });
        useSessionsStore.getState().setActive(existingSession.id);
      } else {
        // A dead/remount reconnect supersedes any candidate request that was
        // staged while the old PTY was still live, including its credentials.
        takeSshReconnect(existingSession.id);
        const endpointChanged = existingSession.remote.host !== remote.host
          || existingSession.remote.port !== remote.port
          || existingSession.remote.user !== remote.user;
        const label = `${remote.user}@${remote.host}`;
        useSessionsStore.getState().updateSession(existingSession.id, {
          remote,
          dir: endpointChanged ? label : existingSession.dir,
          title: endpointChanged && !existingSession.customTitle ? label : existingSession.title,
          ptyId: undefined,
          runState: "idle",
          startedAt: undefined,
          completedAt: undefined,
          lastExitCode: undefined,
          terminalProgress: undefined,
          reconnectNonce,
          terminalMountNonce: reconnectNonce,
        });
        useSessionsStore.getState().handleConnectionEvent(existingSession.id, { type: "openRequested", transport: "ssh", source: "user" });
        useSessionsStore.getState().setActive(existingSession.id);
      }
    } else {
      addSession(session);
    }
    // A connection opens into its terminal. Keep remote Files opt-in even when
    // the inspector was left on Files for the previous local session.
    useUIStore.getState().setInspectorTab("overview");
    setOverlay(null);
    onClose();
  };

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "var(--backdrop-color)", zIndex: 200, animation: "fadeIn var(--duration-normal) var(--ease-smooth)" }} />
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ssh-connect-title"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
          const target = event.target;
          const excludesSubmit = target instanceof HTMLButtonElement
            || (target instanceof HTMLInputElement && ["checkbox", "radio"].includes(target.type));
          if (event.key === "Enter" && !excludesSubmit) {
            event.preventDefault();
            if (canConnect) connect();
          }
        }}
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 520,
          maxWidth: "calc(100vw - 32px)",
          maxHeight: "calc(100vh - 32px)",
          background: "var(--c-bg-white)",
          borderRadius: "var(--r-overlay)",
          boxShadow: "var(--shadow-overlay)",
          zIndex: 201,
          animation: "sheetIn var(--duration-normal) var(--ease-out-back)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          outline: "none",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", borderBottom: "1px solid var(--c-border-2)", flexShrink: 0 }}>
          <div>
            <span id="ssh-connect-title" style={{ display: "block", fontSize: "var(--fs-title)", fontWeight: 650, color: "var(--c-text-primary)" }}>
              {prefill?.reconnectSessionId ? t("ssh.reconnect.title") : t("ssh.title")}
            </span>
            <span style={{ display: "block", marginTop: 2, fontSize: "var(--fs-meta)", color: "var(--c-text-5)" }}>
              {t("ssh.subtitle")}
            </span>
          </div>
          <button type="button" onClick={onClose} aria-label={t("common.close")} className="hover-bg" style={{ width: 26, height: 26, border: "none", background: "transparent", cursor: "pointer", color: "var(--c-text-4)", borderRadius: "var(--r-btn)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <CloseIcon />
          </button>
        </div>

        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 15, overflowY: "auto", minHeight: 0 }}>
          <section aria-labelledby="ssh-sources-label" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <span id="ssh-sources-label" style={{ ...labelStyle, marginBottom: 0 }}>{t("ssh.quick_connect")}</span>
              <button type="button" onClick={() => { void refreshConfig(true); }} disabled={loadingConfig} className="hover-bg" style={{ border: "none", background: "transparent", color: "var(--c-text-4)", fontSize: "var(--fs-meta)", cursor: loadingConfig ? "wait" : "pointer", padding: "3px 5px", borderRadius: "var(--r-btn)" }}>
                {loadingConfig ? t("ssh.config.loading") : t("ssh.config.refresh")}
              </button>
            </div>
            {hasSources ? (
              <>
                <div style={{ position: "relative" }}>
                  <span aria-hidden="true" style={{ position: "absolute", left: 9, top: 9, color: "var(--c-text-5)", display: "flex" }}><SearchIcon /></span>
                  <input id="ssh-profile-search" aria-label={t("ssh.search_placeholder")} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("ssh.search_placeholder")} spellCheck={false} style={{ ...fieldStyle, paddingLeft: 30 }} />
                </div>
                <div style={{ maxHeight: 132, overflowY: "auto", border: "1px solid var(--c-border-2)", borderRadius: "var(--r-input)", padding: 3 }}>
                  {filteredHosts.map((profile) => (
                    <ProfileRow
                      key={`saved:${profile.id}`}
                      profile={profile}
                      source="saved"
                      onSelect={() => fillFrom(profile)}
                      onDelete={() => deleteProfile(profile.id)}
                      deletePending={isPending(`ssh-profile:${profile.id}`)}
                    />
                  ))}
                  {filteredConfigHosts.map((profile) => (
                    <ProfileRow key={`config:${profile.id}`} profile={profile} source="config" onSelect={() => fillFrom(profile)} />
                  ))}
                  {filteredHosts.length + filteredConfigHosts.length === 0 && (
                    <div style={{ padding: "12px 8px", textAlign: "center", color: "var(--c-text-5)", fontSize: "var(--fs-meta)" }}>{t("ssh.search_empty")}</div>
                  )}
                </div>
              </>
            ) : !loadingConfig ? (
              <span style={{ color: "var(--c-text-5)", fontSize: "var(--fs-meta)" }}>{t("ssh.sources_empty")}</span>
            ) : null}
            {configSkipped > 0 && (
              <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-warning-text)", lineHeight: 1.4 }}>
                {t("ssh.config.skipped", { count: configSkipped })}
              </span>
            )}
          </section>

          <section aria-labelledby="ssh-endpoint-label" style={{ display: "flex", flexDirection: "column", gap: 11 }}>
            <span id="ssh-endpoint-label" style={labelStyle}>{t("ssh.endpoint")}</span>
            <div style={{ display: "flex", gap: 10 }}>
              <div style={{ flex: 3 }}>
                <label htmlFor="ssh-connect-host" style={labelStyle}>{t("ssh.host")}</label>
                <input ref={hostRef} id="ssh-connect-host" style={fieldStyle} value={host} placeholder={t("ssh.host_placeholder")} onChange={(event) => setHost(event.target.value)} spellCheck={false} autoCapitalize="off" />
              </div>
              <div style={{ flex: 1 }}>
                <label htmlFor="ssh-connect-port" style={labelStyle}>{t("ssh.port")}</label>
                <input id="ssh-connect-port" style={fieldStyle} value={port} inputMode="numeric" aria-invalid={portInvalid} onChange={(event) => setPort(event.target.value.replace(/[^0-9]/g, ""))} />
              </div>
            </div>
            <div>
              <label htmlFor="ssh-connect-user" style={labelStyle}>{t("ssh.user")}</label>
              <input id="ssh-connect-user" style={fieldStyle} value={user} placeholder={t("ssh.user_placeholder")} onChange={(event) => setUser(event.target.value)} spellCheck={false} autoCapitalize="off" />
            </div>
          </section>

          <fieldset style={{ margin: 0, padding: 0, border: "none", display: "flex", flexDirection: "column", gap: 9 }}>
            <legend style={{ ...labelStyle, padding: 0 }}>{t("ssh.auth.method")}</legend>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 6 }}>
              {AUTH_METHODS.map((method) => {
                const selected = authMethod === method;
                return (
                  <label key={method} className="hover-bg" style={{ display: "flex", alignItems: "flex-start", gap: 7, minWidth: 0, padding: "8px 9px", border: `1px solid ${selected ? "var(--c-accent)" : "var(--c-border-2)"}`, borderRadius: "var(--r-btn)", background: selected ? "var(--c-accent-bg-soft)" : "var(--c-bg-white)", cursor: "pointer" }}>
                    <input type="radio" name="ssh-auth-method" value={method} checked={selected} onChange={() => chooseAuthMethod(method)} style={{ margin: "2px 0 0", accentColor: "var(--c-accent)" }} />
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: "block", color: "var(--c-text-primary)", fontSize: "var(--fs-secondary)", fontWeight: 600 }}>{t(`ssh.auth.${method}.label`)}</span>
                      <span style={{ display: "block", marginTop: 2, color: "var(--c-text-5)", fontSize: "var(--fs-meta)", lineHeight: 1.35 }}>{t(`ssh.auth.${method}.hint`)}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            {!authMethod && <span role="alert" style={{ color: "var(--c-warning-text)", fontSize: "var(--fs-meta)" }}>{t("ssh.auth.choose")}</span>}

            {authMethod === "password" && (
              <div>
                <label htmlFor="ssh-connect-password" style={labelStyle}>{t("ssh.password")}</label>
                <input id="ssh-connect-password" style={fieldStyle} type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="off" spellCheck={false} autoFocus />
                <span style={{ display: "block", marginTop: 5, fontSize: "var(--fs-meta)", color: "var(--c-text-4)", lineHeight: 1.4 }}>{t("ssh.auth.password.strict")}</span>
              </div>
            )}

            {authMethod === "key" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                <div>
                  <label htmlFor="ssh-connect-identity" style={labelStyle}>{t("ssh.identityFile")}</label>
                  <div style={{ display: "flex", gap: 6 }}>
                    <input id="ssh-connect-identity" style={fieldStyle} value={identityFile} placeholder={t("ssh.identity_placeholder")} onChange={(event) => setIdentityFile(event.target.value)} spellCheck={false} autoCapitalize="off" />
                    <button type="button" onClick={() => { void chooseIdentityFile(); }} className="hover-bg" style={{ flexShrink: 0, padding: "0 11px", borderRadius: "var(--r-btn)", border: "1px solid var(--c-border-2)", background: "var(--c-bg-white)", color: "var(--c-text-2)", fontSize: "var(--fs-secondary)", cursor: "pointer" }}>{t("ssh.identity_picker.choose")}</button>
                  </div>
                </div>
                <div>
                  <label htmlFor="ssh-connect-passphrase" style={labelStyle}>{t("ssh.keyPassphrase")}</label>
                  <input id="ssh-connect-passphrase" style={fieldStyle} type="password" value={keyPassphrase} onChange={(event) => setKeyPassphrase(event.target.value)} autoComplete="off" spellCheck={false} />
                </div>
              </div>
            )}

            {authMethod === "keyboard-interactive" && (
              <span style={{ padding: "8px 10px", borderRadius: "var(--r-btn)", background: "var(--c-bg-1)", color: "var(--c-text-4)", fontSize: "var(--fs-meta)", lineHeight: 1.45 }}>{t("ssh.auth.keyboard-interactive.detail")}</span>
            )}
          </fieldset>

          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: "var(--fs-secondary)", color: "var(--c-text-primary)" }}>
            <input type="checkbox" checked={saveProfile} onChange={(event) => setSaveProfile(event.target.checked)} />
            <span>{t("ssh.saveProfile")}<span style={{ display: "block", marginTop: 1, color: "var(--c-text-5)", fontSize: "var(--fs-meta)" }}>{t("ssh.saveProfileHint")}</span></span>
          </label>

          <details>
            <summary style={{ cursor: "pointer", color: "var(--c-text-4)", fontSize: "var(--fs-secondary)" }}>{t("ssh.advanced")}</summary>
            <label style={{ display: "flex", alignItems: "flex-start", gap: 8, marginTop: 10, cursor: "pointer", fontSize: "var(--fs-secondary)", color: "var(--c-text-primary)" }}>
              <input type="checkbox" checked={injectIntegration} onChange={(event) => setInjectIntegration(event.target.checked)} style={{ marginTop: 2 }} />
              <span>{t("ssh.injectIntegration")}<span style={{ display: "block", marginTop: 2, fontSize: "var(--fs-meta)", color: "var(--c-text-4)", lineHeight: 1.4 }}>{t("ssh.injectIntegrationHint")}</span></span>
            </label>
          </details>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "12px 18px", borderTop: "1px solid var(--c-border-2)", flexShrink: 0 }}>
          <span style={{ color: "var(--c-text-5)", fontSize: "var(--fs-meta)" }}>{t("ssh.credentialsHint")}</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={onClose} className="hover-bg" style={{ padding: "6px 16px", borderRadius: "var(--r-btn)", border: "1px solid var(--c-border-2)", background: "transparent", color: "var(--c-text-primary)", fontSize: "var(--fs-body)", cursor: "pointer" }}>{t("common.cancel")}</button>
            <button type="button" onClick={connect} disabled={!canConnect} className="hover-primary" style={{ padding: "6px 18px", borderRadius: "var(--r-btn)", border: "none", background: "var(--c-btn-primary-bg)", color: "var(--c-btn-primary-text)", fontSize: "var(--fs-body)", fontWeight: 500, cursor: canConnect ? "pointer" : "not-allowed", opacity: canConnect ? 1 : 0.5 }}>
              {prefill?.reconnectSessionId ? t("terminal.exited.reconnect") : t("ssh.connect")}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
