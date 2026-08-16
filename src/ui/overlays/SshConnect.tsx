import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useSessionsStore, createRemoteSession } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { CloseIcon, SearchIcon } from "../shared";
import { useT } from "@/modules/i18n";
import {
  saveHost,
  removeHost,
  makeHostId,
  normalizeSshPort,
  parseSshPort,
  importSshConfig,
  loadSshProfilesPanel,
  toProfilesPanelModel,
  resolveSshProfileRoute,
  type SshAuthMethod,
  type SshHostProfile,
  type SshImportDiagnosticV1,
  type SshProfileRouteResolutionV1,
  type SshProfileRouteV1,
  type SshProfileSourceV1,
  type SshProfilesPanelActionsV1,
  type SshProfilesPanelModelV1,
} from "@/modules/ssh/hosts-bridge";
import { stashSshCredentials } from "@/modules/ssh/pending-credentials";
import { captureSshReconnectForwards } from "@/modules/ssh/auto-reconnect";
import type { RemoteInfo } from "../types";
import { useFocusTrap } from "./useFocusTrap";
import { useDestructiveConfirm } from "../lib/destructive-confirm";

interface SshConnectProps {
  onClose: () => void;
}

const AUTH_METHODS: SshAuthMethod[] = ["agent", "key", "password", "keyboard-interactive"];
const EMPTY_PANEL_MODEL: SshProfilesPanelModelV1 = {
  schemaVersion: 1,
  savedProfiles: [],
  configProfiles: [],
  configSkipped: 0,
  configDiagnostics: [],
};

const fieldStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  fontSize: "var(--fs-body)",
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
  source: SshProfileSourceV1;
  onSelect: () => void;
  onDelete?: () => void;
  deletePending?: boolean;
}) {
  const t = useT();
  return (
    <div role="listitem" style={{ display: "flex", alignItems: "center", gap: 6, borderRadius: "var(--r-btn)" }}>
      <button
        type="button"
        onClick={onSelect}
        className="hover-bg ssh-profile-row"
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "stretch",
          gap: 2,
          padding: "7px 8px",
          border: "none",
          borderRadius: "var(--r-btn)",
          background: "transparent",
          color: "var(--c-text-primary)",
          cursor: "pointer",
          textAlign: "left",
        }}
      >
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "var(--fs-body)", fontWeight: 550 }}>
          {profile.label || `${profile.user}@${profile.host}`}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, color: "var(--c-text-5)", fontSize: "var(--fs-meta)" }}>
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)" }}>
            {profile.user ? `${profile.user}@` : ""}{profile.host}{profile.port !== 22 ? `:${profile.port}` : ""}
          </span>
          <span className="ssh-profile-auth" style={{ flexShrink: 0, whiteSpace: "nowrap" }}>
            {source === "sshConfig" ? "~/.ssh/config" : profile.authMethod ? t(`ssh.auth.${profile.authMethod}.short`) : t("ssh.auth.choose.short")}
          </span>
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
  const passwordRef = useRef<HTMLInputElement>(null);
  const addSession = useSessionsStore((s) => s.addSession);
  const setOverlay = useUIStore((s) => s.setOverlay);
  const prefill = useUIStore.getState().sshPrefill;

  const [host, setHost] = useState(prefill?.host ?? "");
  const [port, setPort] = useState(prefill?.port ? String(prefill.port) : "22");
  const [user, setUser] = useState(prefill?.user ?? "");
  const [authMethod, setAuthMethod] = useState<SshAuthMethod | undefined>(prefill?.authMethod);
  const [identityFile, setIdentityFile] = useState(prefill?.identityFile ?? "");
  const [certificateFile, setCertificateFile] = useState(prefill?.certificateFile ?? "");
  const [keyPassphrase, setKeyPassphrase] = useState("");
  const [password, setPassword] = useState("");
  const [saveProfile, setSaveProfile] = useState(false);
  const [injectIntegration, setInjectIntegration] = useState(prefill?.injectShellIntegration ?? true);
  const [autoReconnect, setAutoReconnect] = useState(prefill?.autoReconnect ?? false);
  const [panelModel, setPanelModel] = useState<SshProfilesPanelModelV1>(EMPTY_PANEL_MODEL);
  const forwardSnapshotInFlight = useRef(false);
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [query, setQuery] = useState("");
  const [jumpProfileId, setJumpProfileId] = useState(prefill?.route?.profileId ?? "");
  const [selectedProfile, setSelectedProfile] = useState<{ id: string; source: SshProfileSourceV1 } | null>(null);
  const [routeResolution, setRouteResolution] = useState<SshProfileRouteResolutionV1 | null>(null);
  const [jumpAuthMethod, setJumpAuthMethod] = useState<SshAuthMethod | undefined>(prefill?.route?.jump.authMethod);
  const [jumpIdentityFile, setJumpIdentityFile] = useState(prefill?.route?.jump.identityFile ?? "");
  const [jumpCertificateFile, setJumpCertificateFile] = useState(prefill?.route?.jump.certificateFile ?? "");
  const [jumpPassword, setJumpPassword] = useState("");
  const [jumpKeyPassphrase, setJumpKeyPassphrase] = useState("");
  const configGeneration = useRef(0);
  const diagnosticsRef = useRef<HTMLDetailsElement>(null);

  useFocusTrap(containerRef);

  useEffect(() => {
    (prefill?.host ? hostRef : containerRef).current?.querySelector?.("input")?.focus();
    if (prefill?.host) hostRef.current?.focus();
  }, [prefill?.host]);

  const refreshConfig = async (announce: boolean) => {
    const generation = ++configGeneration.current;
    setLoadingConfig(true);
    setPanelModel((current) => ({ ...current, configProfiles: [], configSkipped: 0, configDiagnostics: [] }));
    // A target or jump may depend on the old resolver generation. Reset the
    // whole route so refreshed endpoints can never inherit stale auth state.
    setSelectedProfile(null);
    setHost("");
    setPort("22");
    setUser("");
    setAuthMethod(undefined);
    setIdentityFile("");
    setCertificateFile("");
    setPassword("");
    setKeyPassphrase("");
    setJumpProfileId("");
    setJumpAuthMethod(undefined);
    setJumpIdentityFile("");
    setJumpCertificateFile("");
    setJumpPassword("");
    setJumpKeyPassphrase("");
    setRouteResolution(null);
    try {
      const result = await importSshConfig();
      if (generation !== configGeneration.current) return;
      setPanelModel((current) => toProfilesPanelModel(current.savedProfiles, result));
      useUIStore.getState().bumpSshProfilesEpoch();
      if (announce) {
        useUIStore.getState().addToast({
          title: t("ssh.config.loaded"),
          subtitle: t("ssh.config.loaded_detail", { available: result.imported.length, skipped: result.skipped }),
          variant: "success",
        });
      }
    } catch {
      if (generation !== configGeneration.current) return;
      if (announce) {
        useUIStore.getState().addToast({ title: t("ssh.config.load_failed"), subtitle: "", variant: "error" });
      }
    } finally {
      if (generation === configGeneration.current) setLoadingConfig(false);
    }
  };

  useEffect(() => {
    const generation = ++configGeneration.current;
    setLoadingConfig(true);
    loadSshProfilesPanel().then((model) => {
      if (generation === configGeneration.current) setPanelModel(model);
    }).catch(() => {
      if (generation === configGeneration.current) {
        setPanelModel(EMPTY_PANEL_MODEL);
        useUIStore.getState().addToast({ title: t("ssh.profile.load_failed"), subtitle: "", variant: "error" });
      }
    }).finally(() => {
      if (generation === configGeneration.current) setLoadingConfig(false);
    });
  }, [t]);

  const fillFrom = (profileId: string, source: SshProfileSourceV1) => {
    const resolution = resolveSshProfileRoute(profileId, source, panelModel);
    setSelectedProfile({ id: profileId, source });
    setRouteResolution(resolution);
    setJumpProfileId("");
    if (resolution.status === "rejected") return;
    const { target: profile, jump } = resolution.route;
    setHost(profile.host);
    setPort(String(profile.port));
    setUser(profile.user);
    setAuthMethod(profile.authMethod);
    setIdentityFile(profile.authMethod === "key" || !profile.authMethod ? profile.identityFile : "");
    setCertificateFile(profile.authMethod === "key" || !profile.authMethod ? profile.certificateFile ?? "" : "");
    setPassword("");
    setKeyPassphrase("");
    setJumpPassword("");
    setJumpKeyPassphrase("");
    setJumpProfileId(jump?.id ?? "");
    setJumpAuthMethod(jump?.authMethod);
    setJumpIdentityFile(jump?.authMethod === "key" || !jump?.authMethod ? jump?.identityFile ?? "" : "");
    setJumpCertificateFile(jump?.authMethod === "key" || !jump?.authMethod ? jump?.certificateFile ?? "" : "");
    requestAnimationFrame(() => hostRef.current?.focus());
  };

  const deleteProfile = (id: string) => {
    tryConfirm(`ssh-profile:${id}`, () => {
      removeHost(id)
        .then((savedProfiles) => {
          setPanelModel((current) => ({ ...current, savedProfiles }));
          useUIStore.getState().bumpSshProfilesEpoch();
        })
        .catch(() => useUIStore.getState().addToast({ title: t("ssh.profile.remove_failed"), subtitle: "", variant: "error" }));
    });
  };

  const chooseAuthMethod = (method: SshAuthMethod) => {
    setAuthMethod(method);
    if (method !== "password") setPassword("");
    if (method !== "key") {
      setIdentityFile("");
      setCertificateFile("");
      setKeyPassphrase("");
    }
  };

  const chooseJumpAuthMethod = (method: SshAuthMethod) => {
    setJumpAuthMethod(method);
    if (method !== "password") setJumpPassword("");
    if (method !== "key") {
      setJumpIdentityFile("");
      setJumpCertificateFile("");
      setJumpKeyPassphrase("");
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

  const chooseCertificateFile = async () => {
    try {
      const selected = await open({
        directory: false,
        multiple: false,
        title: t("ssh.certificate_picker.title"),
        defaultPath: certificateFile.trim() || undefined,
      });
      if (typeof selected === "string") setCertificateFile(selected);
    } catch {
      useUIStore.getState().addToast({ title: t("ssh.certificate_picker.failed"), subtitle: "", variant: "error" });
    }
  };

  const chooseJumpIdentityFile = async () => {
    try {
      const selected = await open({
        directory: false,
        multiple: false,
        title: t("ssh.identity_picker.title"),
        defaultPath: jumpIdentityFile.trim() || undefined,
      });
      if (typeof selected === "string") setJumpIdentityFile(selected);
    } catch {
      useUIStore.getState().addToast({ title: t("ssh.identity_picker.failed"), subtitle: "", variant: "error" });
    }
  };

  const chooseJumpCertificateFile = async () => {
    try {
      const selected = await open({
        directory: false,
        multiple: false,
        title: t("ssh.certificate_picker.title"),
        defaultPath: jumpCertificateFile.trim() || undefined,
      });
      if (typeof selected === "string") setJumpCertificateFile(selected);
    } catch {
      useUIStore.getState().addToast({ title: t("ssh.certificate_picker.failed"), subtitle: "", variant: "error" });
    }
  };

  const normalizedQuery = query.trim().toLowerCase();
  const { savedProfiles: hosts, configProfiles: configHosts, configSkipped, configDiagnostics } = panelModel;
  const allProfiles = useMemo(() => [...hosts, ...configHosts], [hosts, configHosts]);
  const jumpOptions = useMemo(() => allProfiles.filter((profile) => !profile.proxyJumpProfileId), [allProfiles]);
  useLayoutEffect(() => {
    const candidates = allProfiles.filter((profile) => profile.id === jumpProfileId);
    const jump = candidates.length === 1 ? candidates[0] : undefined;
    // Keep endpoint and authentication material on the same panel generation.
    // Secrets never survive a profile resolution or refresh.
    setJumpAuthMethod(jump?.authMethod);
    setJumpIdentityFile(jump?.authMethod === "key" || !jump?.authMethod ? jump?.identityFile ?? "" : "");
    setJumpCertificateFile(jump?.authMethod === "key" || !jump?.authMethod ? jump?.certificateFile ?? "" : "");
    setJumpPassword("");
    setJumpKeyPassphrase("");
  }, [allProfiles, jumpProfileId]);
  const manualResolution = useMemo<SshProfileRouteResolutionV1 | null>(() => {
    if (!jumpProfileId) return null;
    const temporaryTarget: SshHostProfile = {
      id: "__ssh-connect-manual-target__",
      label: "",
      host,
      port: normalizeSshPort(port),
      user,
      authMethod,
      identityFile,
      certificateFile,
      proxyJumpProfileId: jumpProfileId,
    };
    return resolveSshProfileRoute(temporaryTarget.id, "saved", {
      ...panelModel,
      savedProfiles: [...panelModel.savedProfiles, temporaryTarget],
    });
  }, [authMethod, certificateFile, host, identityFile, jumpProfileId, panelModel, port, user]);
  const effectiveResolution = jumpProfileId ? manualResolution : routeResolution;
  const resolvedRoute = effectiveResolution?.status === "ready" ? effectiveResolution.route : undefined;
  const jumpProfile = resolvedRoute?.jump;
  const routeError = effectiveResolution?.status === "rejected"
    ? t(`ssh.route.${effectiveResolution.code}`)
    : null;
  const filteredHosts = useMemo(() => hosts.filter((profile) => profileMatches(profile, normalizedQuery)), [hosts, normalizedQuery]);
  const filteredConfigHosts = useMemo(() => configHosts.filter((profile) => profileMatches(profile, normalizedQuery)), [configHosts, normalizedQuery]);
  const hasSources = hosts.length > 0 || configHosts.length > 0;
  const portText = port.trim();
  const portInvalid = portText.length > 0 && parseSshPort(portText) === null;

  // 切到 password 认证时显式聚焦密码框（autoFocus 在 WKWebView 下不可靠）
  useEffect(() => {
    if (authMethod === "password") passwordRef.current?.focus();
  }, [authMethod]);
  const methodReady = authMethod === "key"
    ? identityFile.trim().length > 0
    : authMethod === "password"
      ? password.length > 0
      : authMethod !== undefined;
  const jumpReady = !jumpProfileId || Boolean(jumpProfile && (
    jumpAuthMethod === "key"
      ? jumpIdentityFile.trim().length > 0
      : jumpAuthMethod === "password"
        ? jumpPassword.length > 0
        : jumpAuthMethod !== undefined
  ));
  const canConnect = host.trim().length > 0
    && user.trim().length > 0
    && (portText.length === 0 || parseSshPort(portText) !== null)
    && methodReady && jumpReady && !routeError && !loadingConfig;

  const connect = async () => {
    if (!canConnect || !authMethod) return;
    const safePort = normalizeSshPort(port);
    const trimmedHost = host.trim();
    const trimmedUser = user.trim();
    const trimmedId = authMethod === "key" ? identityFile.trim() : "";
    const trimmedCertificate = authMethod === "key" ? certificateFile.trim() : "";
    const route = jumpProfile && jumpAuthMethod ? { profileId: jumpProfile.id, jump: {
      host: jumpProfile.host, port: jumpProfile.port, user: jumpProfile.user,
      authMethod: jumpAuthMethod,
      ...(jumpAuthMethod === "key" && jumpIdentityFile.trim() ? { identityFile: jumpIdentityFile.trim() } : {}),
      ...(jumpAuthMethod === "key" && jumpCertificateFile.trim() ? { certificateFile: jumpCertificateFile.trim() } : {}),
    } } : undefined;

    if (saveProfile) {
      const selectedSaved = selectedProfile?.source === "saved"
        ? hosts.find((candidate) => candidate.id === selectedProfile.id)
        : undefined;
      const existing = selectedSaved ?? hosts.find((candidate) =>
        candidate.host === trimmedHost
        && candidate.port === safePort
        && candidate.user === trimmedUser
        && (candidate.proxyJumpProfileId ?? "") === jumpProfileId
      );
      void actions.onSave({
        id: existing?.id ?? makeHostId(),
        label: existing?.label ?? `${trimmedUser}@${trimmedHost}`,
        host: trimmedHost,
        port: safePort,
        user: trimmedUser,
        authMethod,
        identityFile: trimmedId,
        certificateFile: trimmedCertificate,
        ...(jumpProfileId ? { proxyJumpProfileId: jumpProfileId } : {}),
      });
    }

    const remote: RemoteInfo = {
      host: trimmedHost,
      port: safePort,
      user: trimmedUser,
      authMethod,
      ...(authMethod === "key" && trimmedId ? { identityFile: trimmedId } : {}),
      ...(authMethod === "key" && trimmedCertificate ? { certificateFile: trimmedCertificate } : {}),
      injectShellIntegration: injectIntegration,
      ...(autoReconnect ? { autoReconnect: true } : {}),
      ...(route ? { route } : {}),
    };
    const reconnectSessionId = prefill?.reconnectSessionId;
    const existingSession = reconnectSessionId
      ? useSessionsStore.getState().sessions.find((session) => session.id === reconnectSessionId)
      : undefined;
    // A different endpoint is a different trust/filesystem boundary. Keep the
    // old disconnected session (including drafts/history) and open a new one
    // rather than rebinding its file tabs to another host.
    const sameEndpoint = Boolean(
      existingSession?.remote
      && existingSession.remote.host === remote.host
      && existingSession.remote.port === remote.port
      && existingSession.remote.user === remote.user
      && JSON.stringify(existingSession.remote.route ?? null) === JSON.stringify(remote.route ?? null),
    );
    const session = existingSession?.remote && sameEndpoint
      ? existingSession
      : createRemoteSession(remote);
    let reconnectForwards = prefill?.reconnectForwards;
    if (existingSession?.remote && sameEndpoint) {
      if (forwardSnapshotInFlight.current) return;
      forwardSnapshotInFlight.current = true;
      try {
        reconnectForwards = await captureSshReconnectForwards(existingSession);
      } catch {
        useUIStore.getState().addToast({ title: t("ssh.forward.snapshotFailed"), subtitle: "", variant: "error" });
        return;
      } finally {
        forwardSnapshotInFlight.current = false;
      }
    }

    stashSshCredentials(session.id, {
      password: authMethod === "password" ? password : undefined,
      keyPassphrase: authMethod === "key" ? keyPassphrase || undefined : undefined,
      jumpPassword: route && jumpAuthMethod === "password" ? jumpPassword : undefined,
      jumpKeyPassphrase: route && jumpAuthMethod === "key" ? jumpKeyPassphrase || undefined : undefined,
    });
    setPassword("");
    setKeyPassphrase("");
    setJumpPassword("");
    setJumpKeyPassphrase("");

    if (existingSession?.remote && sameEndpoint) {
      const reconnectNonce = (existingSession.reconnectNonce ?? 0) + 1;
      const reconnectLifecycle = (existingSession.sshReconnectLifecycle ?? 0) + 1;
      useSessionsStore.getState().updateSession(existingSession.id, {
        remote,
        dir: existingSession.dir,
        title: existingSession.title,
        ptyId: undefined,
        transportGeneration: undefined,
        sshReconnectAttempt: undefined,
        sshReconnectLifecycle: reconnectLifecycle,
        sshReconnectNeedsCredential: false,
        sshReconnectForwards: reconnectForwards,
        runState: "idle",
        startedAt: undefined,
        completedAt: undefined,
        lastExitCode: undefined,
        terminalProgress: undefined,
        pendingInput: undefined,
        pendingInputSubmit: undefined,
        reconnectNonce,
        // Every SSH transport gets a fresh xterm parser and protocol state.
        terminalMountNonce: reconnectNonce,
      });
      useSessionsStore.getState().handleConnectionEvent(existingSession.id, { type: "reconnectRequested" });
      useSessionsStore.getState().setActive(existingSession.id);
    } else {
      addSession(session);
    }
    // A connection opens into its terminal. Keep remote Files opt-in even when
    // the inspector was left on Files for the previous local session.
    useUIStore.getState().setInspectorTab("overview");
    setOverlay(null);
    onClose();
  };

  const actions: SshProfilesPanelActionsV1 = {
    onConnect: (_route: SshProfileRouteV1) => connect(),
    onSave: async (profile) => {
      try {
        const savedProfiles = await saveHost(profile);
        setPanelModel((current) => ({ ...current, savedProfiles }));
        useUIStore.getState().bumpSshProfilesEpoch();
      } catch {
        useUIStore.getState().addToast({ title: t("ssh.profile.save_failed"), subtitle: "", variant: "error" });
      }
    },
    onRemove: deleteProfile,
    onRefreshConfig: () => refreshConfig(true),
    onOpenConfigDiagnostic: (_diagnostic: SshImportDiagnosticV1) => {
      if (diagnosticsRef.current) diagnosticsRef.current.open = true;
      diagnosticsRef.current?.focus();
    },
  };

  return (
    <>
      <div aria-hidden="true" onClick={onClose} style={{ position: "fixed", inset: 0, background: "var(--backdrop-color)", zIndex: 200, animation: "fadeIn var(--duration-normal) var(--ease-smooth)" }} />
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ssh-connect-title"
        aria-describedby="ssh-connect-subtitle"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
            return;
          }
          const target = event.target;
          const excludesSubmit = target instanceof HTMLButtonElement
            || target instanceof HTMLSelectElement
            || target instanceof HTMLTextAreaElement
            || (target instanceof HTMLInputElement && (
              ["checkbox", "radio", "search"].includes(target.type)
              || target.id === "ssh-profile-search"
            ));
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
            <span id="ssh-connect-subtitle" style={{ display: "block", marginTop: 2, fontSize: "var(--fs-meta)", color: "var(--c-text-5)" }}>
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
              <button type="button" onClick={() => { void actions.onRefreshConfig(); }} disabled={loadingConfig} className="hover-bg" style={{ border: "none", background: "transparent", color: "var(--c-text-4)", fontSize: "var(--fs-meta)", cursor: loadingConfig ? "wait" : "pointer", padding: "3px 5px", borderRadius: "var(--r-btn)" }}>
                {loadingConfig ? t("ssh.config.loading") : t("ssh.config.refresh")}
              </button>
            </div>
            {hasSources ? (
              <>
                <div style={{ position: "relative" }}>
                  <span aria-hidden="true" style={{ position: "absolute", left: 9, top: 9, color: "var(--c-text-5)", display: "flex" }}><SearchIcon /></span>
                  <input id="ssh-profile-search" className="ui-control" aria-label={t("ssh.search_placeholder")} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("ssh.search_placeholder")} spellCheck={false} style={{ ...fieldStyle, paddingLeft: 30 }} />
                </div>
                <div role="list" aria-label={t("ssh.quick_connect")} style={{ maxHeight: 132, overflowY: "auto", border: "1px solid var(--c-border-2)", borderRadius: "var(--r-input)", padding: 3 }}>
                  {filteredHosts.map((profile) => (
                    <ProfileRow
                      key={`saved:${profile.id}`}
                      profile={profile}
                      source="saved"
                      onSelect={() => fillFrom(profile.id, "saved")}
                      onDelete={() => { void actions.onRemove(profile.id); }}
                      deletePending={isPending(`ssh-profile:${profile.id}`)}
                    />
                  ))}
                  {filteredConfigHosts.map((profile) => (
                    <ProfileRow key={`config:${profile.id}`} profile={profile} source="sshConfig" onSelect={() => fillFrom(profile.id, "sshConfig")} />
                  ))}
                  {filteredHosts.length + filteredConfigHosts.length === 0 && (
                    <div role="listitem" style={{ padding: "12px 8px", textAlign: "center", color: "var(--c-text-5)", fontSize: "var(--fs-meta)" }}>{t("ssh.search_empty")}</div>
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
            <span role="status" style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)" }}>
              {t("ssh.config.summary", { available: configHosts.length, skipped: configSkipped })}
            </span>
            <details ref={diagnosticsRef} tabIndex={-1} aria-label={t("ssh.config.diagnostics") }>
              <summary>{t("ssh.config.diagnostics")}</summary>
              <p style={{ fontSize: "var(--fs-meta)", lineHeight: 1.45 }}>{t("ssh.config.support_matrix")}</p>
              <p style={{ fontSize: "var(--fs-meta)", lineHeight: 1.45 }}>{t("ssh.config.never_execute")}</p>
              {configDiagnostics.map((item, index) => (
                <button type="button" onClick={() => actions.onOpenConfigDiagnostic(item)} key={`${item.source}:${item.line ?? ""}:${index}`} style={{ display: "block", border: 0, background: "transparent", padding: 0, color: "inherit", fontFamily: "var(--font-mono)", fontSize: "var(--fs-meta)", textAlign: "left" }}>
                  {[item.severity, item.source + (item.line == null ? "" : `:${item.line}`), item.alias, item.code, item.directive].filter((part): part is string => Boolean(part)).join(" · ")}
                </button>
              ))}
            </details>
          </section>

          <section aria-labelledby="ssh-endpoint-label" style={{ display: "flex", flexDirection: "column", gap: 11 }}>
            <span id="ssh-endpoint-label" style={labelStyle}>{t("ssh.endpoint")}</span>
            <div style={{ display: "flex", gap: 10 }}>
              <div style={{ flex: 3 }}>
                <label htmlFor="ssh-connect-host" style={labelStyle}>{t("ssh.host")}</label>
                <input ref={hostRef} id="ssh-connect-host" className="ui-control" style={fieldStyle} value={host} placeholder={t("ssh.host_placeholder")} onChange={(event) => setHost(event.target.value)} spellCheck={false} autoCapitalize="off" />
              </div>
              <div style={{ flex: 1 }}>
                <label htmlFor="ssh-connect-port" style={labelStyle}>{t("ssh.port")}</label>
                <input id="ssh-connect-port" className="ui-control" style={fieldStyle} value={port} inputMode="numeric" aria-invalid={portInvalid} aria-describedby={portInvalid ? "ssh-connect-port-error" : undefined} onChange={(event) => setPort(event.target.value.replace(/[^0-9]/g, ""))} />
              </div>
            </div>
            {portInvalid && (
              <span id="ssh-connect-port-error" role="alert" style={{ display: "block", marginTop: -5, fontSize: "var(--fs-meta)", color: "var(--c-warning-text)", lineHeight: 1.35 }}>
                {t("ssh.port_invalid")}
              </span>
            )}
            <div>
              <label htmlFor="ssh-connect-user" style={labelStyle}>{t("ssh.user")}</label>
              <input id="ssh-connect-user" className="ui-control" style={fieldStyle} value={user} placeholder={t("ssh.user_placeholder")} onChange={(event) => setUser(event.target.value)} spellCheck={false} autoCapitalize="off" />
            </div>
          </section>

          <fieldset style={{ margin: 0, padding: 0, border: "none" }}>
            <legend style={labelStyle}>{t("ssh.route.legend")}</legend>
            <label htmlFor="ssh-jump-profile" style={labelStyle}>{t("ssh.route.selector")}</label>
            <select id="ssh-jump-profile" className="ui-control" value={jumpProfileId} style={fieldStyle} onChange={(event) => {
              const nextId = event.target.value;
              setJumpProfileId(nextId);
              setRouteResolution(null);
            }}>
              <option value="">{t("ssh.route.direct")}</option>
              {jumpOptions.map((profile, index) => <option key={`${profile.id}:${index}`} value={profile.id}>{profile.label}</option>)}
            </select>
            {routeError && <p role="alert" style={{ color: "var(--c-warning-text)" }}>{routeError}</p>}
            {jumpProfile && (
              <fieldset style={{ marginTop: 10, border: "1px solid var(--c-border-2)", borderRadius: "var(--r-btn)" }}>
                <legend>{t("ssh.route.jump_legend")}</legend>
                <p style={{ fontSize: "var(--fs-meta)" }}>{jumpProfile.user}@{jumpProfile.host}:{jumpProfile.port}</p>
                <div role="radiogroup" aria-label={t("ssh.route.jump_auth_method")} style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 6 }}>
                  {AUTH_METHODS.map((method) => (
                    <label key={`jump:${method}`} className="hover-bg" style={{ display: "flex", alignItems: "center", gap: 6, padding: 6, border: "1px solid var(--c-border-2)", borderRadius: "var(--r-btn)" }}>
                      <input className="ui-choice" type="radio" name="ssh-jump-auth-method" value={method} checked={jumpAuthMethod === method} onChange={() => chooseJumpAuthMethod(method)} />
                      <span>{t(`ssh.auth.${method}.label`)}</span>
                    </label>
                  ))}
                </div>
                {!jumpAuthMethod && <p role="alert">{t("ssh.route.jump_auth_required")}</p>}
                {jumpAuthMethod === "password" && <label htmlFor="ssh-jump-password">{t("ssh.route.jump_password")}<input id="ssh-jump-password" className="ui-control" type="password" style={fieldStyle} value={jumpPassword} onChange={(event) => setJumpPassword(event.target.value)} autoComplete="off" spellCheck={false} /></label>}
                {jumpAuthMethod === "key" && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                    <label htmlFor="ssh-jump-identity">{t("ssh.identityFile")}</label>
                    <div style={{ display: "flex", gap: 6 }}>
                      <input id="ssh-jump-identity" className="ui-control" style={fieldStyle} value={jumpIdentityFile} onChange={(event) => setJumpIdentityFile(event.target.value)} spellCheck={false} autoCapitalize="off" />
                      <button type="button" className="ui-button" onClick={() => { void chooseJumpIdentityFile(); }}>{t("ssh.identity_picker.choose")}</button>
                    </div>
                    <label htmlFor="ssh-jump-passphrase">{t("ssh.route.jump_passphrase")}</label>
                    <input id="ssh-jump-passphrase" className="ui-control" type="password" style={fieldStyle} value={jumpKeyPassphrase} onChange={(event) => setJumpKeyPassphrase(event.target.value)} autoComplete="off" spellCheck={false} />
                    <label htmlFor="ssh-jump-certificate">{t("ssh.certificateFile")}</label>
                    <div style={{ display: "flex", gap: 6 }}>
                      <input id="ssh-jump-certificate" className="ui-control" style={fieldStyle} value={jumpCertificateFile} onChange={(event) => setJumpCertificateFile(event.target.value)} spellCheck={false} autoCapitalize="off" />
                      <button type="button" className="ui-button" onClick={() => { void chooseJumpCertificateFile(); }}>{t("ssh.identity_picker.choose")}</button>
                    </div>
                  </div>
                )}
                {jumpAuthMethod === "agent" && <p style={{ fontSize: "var(--fs-meta)" }}>{t("ssh.auth.agent.boundaries")}</p>}
              </fieldset>
            )}
          </fieldset>

          <fieldset style={{ margin: 0, padding: 0, border: "none", display: "flex", flexDirection: "column", gap: 9 }}>
            <legend style={{ ...labelStyle, padding: 0 }}>{t("ssh.auth.target_legend")}</legend>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 6 }}>
              {AUTH_METHODS.map((method) => {
                const selected = authMethod === method;
                return (
                  <label key={method} className="hover-bg" style={{ display: "flex", alignItems: "flex-start", gap: 7, minWidth: 0, padding: "8px 9px", border: `1px solid ${selected ? "var(--c-accent)" : "var(--c-border-2)"}`, borderRadius: "var(--r-btn)", background: selected ? "var(--c-accent-bg-soft)" : "var(--c-bg-white)", cursor: "pointer" }}>
                    <input className="ui-choice" type="radio" name="ssh-auth-method" value={method} checked={selected} onChange={() => chooseAuthMethod(method)} style={{ margin: "2px 0 0" }} />
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: "block", color: "var(--c-text-primary)", fontSize: "var(--fs-secondary)", fontWeight: 600 }}>{t(`ssh.auth.${method}.label`)}</span>
                      <span style={{ display: "block", marginTop: 2, color: "var(--c-text-5)", fontSize: "var(--fs-meta)", lineHeight: 1.35 }}>{t(`ssh.auth.${method}.hint`)}</span>
                    </span>
                  </label>
                );
              })}
            </div>
            {!authMethod && <span role="alert" style={{ color: "var(--c-warning-text)", fontSize: "var(--fs-meta)" }}>{t("ssh.auth.choose")}</span>}
            {authMethod === "agent" && <span style={{ fontSize: "var(--fs-meta)", lineHeight: 1.45 }}>{t("ssh.auth.agent.boundaries")}</span>}

            {authMethod === "password" && (
              <div>
                <label htmlFor="ssh-connect-password" style={labelStyle}>{t("ssh.password")}</label>
                <input ref={passwordRef} id="ssh-connect-password" className="ui-control" style={fieldStyle} type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="off" spellCheck={false} />
                <span style={{ display: "block", marginTop: 5, fontSize: "var(--fs-meta)", color: "var(--c-text-4)", lineHeight: 1.4 }}>{t("ssh.auth.password.strict")}</span>
              </div>
            )}

            {authMethod === "key" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                <div>
                  <label htmlFor="ssh-connect-identity" style={labelStyle}>{t("ssh.identityFile")}</label>
                  <div style={{ display: "flex", gap: 6 }}>
                    <input id="ssh-connect-identity" className="ui-control" style={fieldStyle} value={identityFile} placeholder={t("ssh.identity_placeholder")} onChange={(event) => setIdentityFile(event.target.value)} spellCheck={false} autoCapitalize="off" />
                    <button type="button" onClick={() => { void chooseIdentityFile(); }} className="ui-button" style={{ flexShrink: 0, padding: "0 11px", fontSize: "var(--fs-secondary)" }}>{t("ssh.identity_picker.choose")}</button>
                  </div>
                </div>
                <div>
                  <label htmlFor="ssh-connect-passphrase" style={labelStyle}>{t("ssh.keyPassphrase")}</label>
                  <input id="ssh-connect-passphrase" className="ui-control" style={fieldStyle} type="password" value={keyPassphrase} onChange={(event) => setKeyPassphrase(event.target.value)} autoComplete="off" spellCheck={false} />
                </div>
                <div>
                  <label htmlFor="ssh-connect-certificate" style={labelStyle}>{t("ssh.certificateFile")}</label>
                  <div style={{ display: "flex", gap: 6 }}>
                    <input id="ssh-connect-certificate" className="ui-control" style={fieldStyle} value={certificateFile} placeholder={t("ssh.certificate_placeholder")} onChange={(event) => setCertificateFile(event.target.value)} spellCheck={false} autoCapitalize="off" />
                    <button type="button" onClick={() => { void chooseCertificateFile(); }} className="ui-button" style={{ flexShrink: 0, padding: "0 11px", fontSize: "var(--fs-secondary)" }}>{t("ssh.identity_picker.choose")}</button>
                  </div>
                </div>
              </div>
            )}

            {authMethod === "keyboard-interactive" && (
              <span style={{ padding: "8px 10px", borderRadius: "var(--r-btn)", background: "var(--c-bg-1)", color: "var(--c-text-4)", fontSize: "var(--fs-meta)", lineHeight: 1.45 }}>{t("ssh.auth.keyboard-interactive.detail")}</span>
            )}
          </fieldset>

          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: "var(--fs-secondary)", color: "var(--c-text-primary)" }}>
            <input className="ui-choice" type="checkbox" checked={saveProfile} onChange={(event) => setSaveProfile(event.target.checked)} />
            <span>{t("ssh.saveProfile")}<span style={{ display: "block", marginTop: 1, color: "var(--c-text-5)", fontSize: "var(--fs-meta)" }}>{t("ssh.saveProfileHint")}</span></span>
          </label>

          <details>
            <summary style={{ cursor: "pointer", color: "var(--c-text-4)", fontSize: "var(--fs-secondary)" }}>{t("ssh.advanced")}</summary>
            <label style={{ display: "flex", alignItems: "flex-start", gap: 8, marginTop: 10, cursor: "pointer", fontSize: "var(--fs-secondary)", color: "var(--c-text-primary)" }}>
              <input className="ui-choice" type="checkbox" checked={injectIntegration} onChange={(event) => setInjectIntegration(event.target.checked)} style={{ marginTop: 2 }} />
              <span>{t("ssh.injectIntegration")}<span style={{ display: "block", marginTop: 2, fontSize: "var(--fs-meta)", color: "var(--c-text-4)", lineHeight: 1.4 }}>{t("ssh.injectIntegrationHint")}</span></span>
            </label>
            <label style={{ display: "flex", alignItems: "flex-start", gap: 8, marginTop: 10, cursor: "pointer", fontSize: "var(--fs-secondary)", color: "var(--c-text-primary)" }}>
              <input className="ui-choice" type="checkbox" checked={autoReconnect} onChange={(event) => setAutoReconnect(event.target.checked)} style={{ marginTop: 2 }} />
              <span>{t("ssh.autoReconnect")}<span style={{ display: "block", marginTop: 2, fontSize: "var(--fs-meta)", color: "var(--c-text-4)", lineHeight: 1.4 }}>{t("ssh.autoReconnectHint")}</span></span>
            </label>
          </details>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "12px 18px", borderTop: "1px solid var(--c-border-2)", flexShrink: 0 }}>
          <span style={{ color: "var(--c-text-5)", fontSize: "var(--fs-meta)" }}>{t("ssh.credentialsHint")}</span>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={onClose} className="ui-button" style={{ padding: "6px 16px", fontSize: "var(--fs-body)" }}>{t("common.cancel")}</button>
            <button type="button" onClick={connect} disabled={!canConnect} className="ui-button ui-button--primary" style={{ padding: "6px 18px", fontSize: "var(--fs-body)", fontWeight: 500 }}>
              {prefill?.reconnectSessionId ? t("terminal.exited.reconnect") : t("ssh.connect")}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
