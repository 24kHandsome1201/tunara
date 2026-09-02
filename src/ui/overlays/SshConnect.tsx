import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSessionsStore, createRemoteSession } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { CloseIcon } from "../shared";
import { useT } from "@/modules/i18n";
import {
  saveHost,
  removeHost,
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
import { sshHostProfileFromSuccessfulConnect } from "@/modules/ssh/save-successful-host";
import { exactSshProfileMatch, filterSshProfiles, formatSshTarget, parseSshTarget, sshTargetHasInvalidPort } from "@/modules/ssh/connect-target";
import { stashSshCredentials } from "@/modules/ssh/pending-credentials";
import { captureSshReconnectForwards } from "@/modules/ssh/auto-reconnect";
import { diagnosticsForSession } from "@/modules/ssh/diagnostics-store";
import type { RemoteInfo } from "../types";
import { useFocusTrap } from "./useFocusTrap";
import { useDestructiveConfirm } from "../lib/destructive-confirm";

interface SshConnectProps {
  onClose: () => void;
}

const AUTH_METHODS: SshAuthMethod[] = ["auto", "agent", "key", "password", "keyboard-interactive"];
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

function SuggestionRow({
  profile,
  source,
  selected,
  active,
  onSelect,
  onDelete,
  deletePending,
}: {
  profile: SshHostProfile;
  source: SshProfileSourceV1;
  selected: boolean;
  active: boolean;
  onSelect: () => void;
  onDelete?: () => void;
  deletePending?: boolean;
}) {
  const t = useT();
  return (
    <div
      role="option"
      aria-selected={selected}
      data-source={source}
      className="ssh-profile-item"
      data-selected={selected || active}
      style={{ display: "flex", alignItems: "center", gap: 4, borderRadius: "var(--r-btn)", background: active ? "var(--c-accent-bg-soft)" : "transparent" }}
    >
      <button
        type="button"
        onClick={onSelect}
        className="hover-bg ssh-profile-row"
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "flex-start",
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
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "var(--fs-body)", fontWeight: 600 }}>
          {profile.label || `${profile.user}@${profile.host}`}
        </span>
        <span style={{ color: "var(--c-text-5)", fontSize: "var(--fs-meta)", fontFamily: "var(--font-mono)" }}>
          {formatSshTarget(profile.user, profile.host, profile.port)}
          {source === "sshConfig" ? " · ~/.ssh/config" : ""}
        </span>
      </button>
      {onDelete && (
        <button
          type="button"
          onClick={onDelete}
          title={deletePending ? t("destructive.confirm_again") : t("ssh.profile.delete")}
          aria-label={deletePending ? t("destructive.confirm_again") : t("ssh.profile.delete")}
          className="hover-close ssh-profile-delete"
          style={{ width: 28, height: 28, flexShrink: 0, border: "none", background: "transparent", cursor: "pointer", color: deletePending ? "var(--c-error)" : "var(--c-text-4)", borderRadius: "var(--r-btn)", display: "flex", alignItems: "center", justifyContent: "center" }}
        >
          <CloseIcon />
        </button>
      )}
    </div>
  );
}

function FileField({
  id,
  label,
  value,
  placeholder,
  onChange,
  onPick,
  chooseLabel,
}: {
  id: string;
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  onPick: () => void;
  chooseLabel: string;
}) {
  return (
    <div>
      <label htmlFor={id} style={labelStyle}>{label}</label>
      <div style={{ display: "flex", gap: 6 }}>
        <input id={id} className="ui-control" style={fieldStyle} value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} spellCheck={false} autoCapitalize="off" />
        <button type="button" className="ui-button" onClick={onPick} style={{ flexShrink: 0, padding: "0 11px", fontSize: "var(--fs-secondary)" }}>{chooseLabel}</button>
      </div>
    </div>
  );
}

/** Compact connection sheet: one target field, Enter connects, auth is automatic. */
export function SshConnect({ onClose }: SshConnectProps) {
  const t = useT();
  const { isPending, tryConfirm } = useDestructiveConfirm();
  const containerRef = useRef<HTMLDivElement>(null);
  const targetRef = useRef<HTMLInputElement>(null);
  const addSession = useSessionsStore((s) => s.addSession);
  const setOverlay = useUIStore((s) => s.setOverlay);
  const prefill = useUIStore.getState().sshPrefill;
  const editingSaved = Boolean(prefill?.host && !prefill.reconnectSessionId && (prefill.authMethod || prefill.identityFile || prefill.route));

  const [target, setTarget] = useState(() => (
    prefill?.host ? formatSshTarget(prefill.user ?? "", prefill.host, prefill.port ?? 22) : ""
  ));
  const [port, setPort] = useState(prefill?.port ? String(prefill.port) : "22");
  const [authMethod, setAuthMethod] = useState<SshAuthMethod>(prefill?.authMethod ?? "auto");
  const [identityFile, setIdentityFile] = useState(prefill?.identityFile ?? "");
  const [certificateFile, setCertificateFile] = useState(prefill?.certificateFile ?? "");
  const [keyPassphrase, setKeyPassphrase] = useState("");
  const [password, setPassword] = useState("");
  const [injectIntegration, setInjectIntegration] = useState(prefill?.injectShellIntegration ?? true);
  const [autoReconnect, setAutoReconnect] = useState(prefill?.autoReconnect ?? false);
  const [panelModel, setPanelModel] = useState<SshProfilesPanelModelV1>(EMPTY_PANEL_MODEL);
  const forwardSnapshotInFlight = useRef(false);
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [jumpProfileId, setJumpProfileId] = useState(prefill?.route?.profileId ?? "");
  const [selectedProfile, setSelectedProfile] = useState<{ id: string; source: SshProfileSourceV1 } | null>(null);
  const [routeResolution, setRouteResolution] = useState<SshProfileRouteResolutionV1 | null>(null);
  const [jumpAuthMethod, setJumpAuthMethod] = useState<SshAuthMethod>(prefill?.route?.jump.authMethod ?? "auto");
  const [jumpIdentityFile, setJumpIdentityFile] = useState(prefill?.route?.jump.identityFile ?? "");
  const [jumpCertificateFile, setJumpCertificateFile] = useState(prefill?.route?.jump.certificateFile ?? "");
  const [jumpPassword, setJumpPassword] = useState("");
  const [jumpKeyPassphrase, setJumpKeyPassphrase] = useState("");
  const configGeneration = useRef(0);
  const diagnosticsRef = useRef<HTMLDetailsElement>(null);
  const connectAttemptRef = useRef(0);
  const connectInFlightRef = useRef(false);
  const [connecting, setConnecting] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(
    editingSaved
    || Boolean(prefill?.reconnectSessionId)
    || Boolean(prefill?.route)
    || Boolean(prefill?.authMethod && prefill.authMethod !== "auto"),
  );
  const [highlight, setHighlight] = useState(-1);
  const [formError, setFormError] = useState("");

  useFocusTrap(containerRef);

  useEffect(() => () => {
    connectAttemptRef.current += 1;
    connectInFlightRef.current = false;
  }, []);

  const cancelConnect = () => {
    connectAttemptRef.current += 1;
    connectInFlightRef.current = false;
    setConnecting(false);
    onClose();
  };

  useEffect(() => {
    targetRef.current?.focus();
  }, []);

  const parsedTarget = useMemo(() => parseSshTarget(target), [target]);
  const host = parsedTarget?.host ?? "";
  const user = parsedTarget?.user ?? "";
  const parsedPort = parsedTarget?.port;

  const resetConnectionForm = () => {
    setSelectedProfile(null);
    setRouteResolution(null);
    setTarget("");
    setPort("22");
    setAuthMethod("auto");
    setIdentityFile("");
    setCertificateFile("");
    setPassword("");
    setKeyPassphrase("");
    setJumpProfileId("");
    setJumpAuthMethod("auto");
    setJumpIdentityFile("");
    setJumpCertificateFile("");
    setJumpPassword("");
    setJumpKeyPassphrase("");
    setHighlight(-1);
    requestAnimationFrame(() => targetRef.current?.focus());
  };

  const refreshConfig = async (announce: boolean) => {
    const generation = ++configGeneration.current;
    setLoadingConfig(true);
    setPanelModel((current) => ({ ...current, configProfiles: [], configSkipped: 0, configDiagnostics: [] }));
    resetConnectionForm();
    try {
      const result = await importSshConfig();
      if (generation !== configGeneration.current) return;
      setPanelModel((current) => toProfilesPanelModel(current.savedProfiles, result));
      useUIStore.getState().bumpSshProfilesEpoch();
      if (announce) setFormError("");
    } catch {
      if (generation !== configGeneration.current) return;
      if (announce) setFormError(t("ssh.config.load_failed"));
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
        setFormError(t("ssh.profile.load_failed"));
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
    if (resolution.status === "rejected") {
      setAdvancedOpen(true);
      return;
    }
    const { target: profile, jump } = resolution.route;
    setTarget(formatSshTarget(profile.user, profile.host, profile.port));
    setPort(String(profile.port));
    setAuthMethod(profile.authMethod ?? "auto");
    setIdentityFile(profile.authMethod === "password" ? "" : profile.identityFile);
    setCertificateFile(profile.authMethod === "password" ? "" : profile.certificateFile ?? "");
    setPassword("");
    setKeyPassphrase("");
    setJumpPassword("");
    setJumpKeyPassphrase("");
    setJumpProfileId(jump?.id ?? "");
    setJumpAuthMethod(jump?.authMethod ?? "auto");
    setJumpIdentityFile(jump?.authMethod === "password" ? "" : jump?.identityFile ?? "");
    setJumpCertificateFile(jump?.authMethod === "password" ? "" : jump?.certificateFile ?? "");
    setAdvancedOpen(true);
    requestAnimationFrame(() => targetRef.current?.focus());
  };

  const deleteProfile = (id: string) => {
    tryConfirm(`ssh-profile:${id}`, () => {
      removeHost(id)
        .then((savedProfiles) => {
          setPanelModel((current) => ({ ...current, savedProfiles }));
          useUIStore.getState().bumpSshProfilesEpoch();
          if (selectedProfile?.source === "saved" && selectedProfile.id === id) resetConnectionForm();
        })
        .catch(() => setFormError(t("ssh.profile.remove_failed")));
    });
  };

  const chooseAuthMethod = (method: SshAuthMethod) => {
    setAuthMethod(method);
    if (method !== "password") setPassword("");
    if (method !== "key" && method !== "auto") {
      setIdentityFile("");
      setCertificateFile("");
      setKeyPassphrase("");
    }
  };

  const chooseJumpAuthMethod = (method: SshAuthMethod) => {
    setJumpAuthMethod(method);
    if (method !== "password") setJumpPassword("");
    if (method !== "key" && method !== "auto") {
      setJumpIdentityFile("");
      setJumpCertificateFile("");
      setJumpKeyPassphrase("");
    }
  };

  const pickFile = async (title: string, current: string, onPicked: (path: string) => void) => {
    try {
      const selected = await open({ directory: false, multiple: false, title, defaultPath: current.trim() || undefined });
      if (typeof selected === "string") onPicked(selected);
    } catch {
      setFormError(t("ssh.identity_picker.failed"));
    }
  };

  const { savedProfiles: hosts, configProfiles: configHosts, configSkipped, configDiagnostics } = panelModel;
  const allProfiles = useMemo(() => [...hosts, ...configHosts], [hosts, configHosts]);
  const jumpOptions = useMemo(() => allProfiles.filter((profile) => !profile.proxyJumpProfileId), [allProfiles]);
  const effectivePortText = parsedPort != null ? String(parsedPort) : port;
  const portText = effectivePortText.trim();
  const portInvalid = sshTargetHasInvalidPort(target) || (portText.length > 0 && parseSshPort(portText) === null);

  const manualResolution = useMemo<SshProfileRouteResolutionV1 | null>(() => {
    if (!jumpProfileId) return null;
    const temporaryTarget: SshHostProfile = {
      id: "__ssh-connect-manual-target__",
      label: "",
      host,
      port: normalizeSshPort(portText),
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
  }, [authMethod, certificateFile, host, identityFile, jumpProfileId, panelModel, portText, user]);
  const effectiveResolution = jumpProfileId ? manualResolution : routeResolution;
  const resolvedRoute = effectiveResolution?.status === "ready" ? effectiveResolution.route : undefined;
  const jumpProfile = resolvedRoute?.jump;
  const routeError = effectiveResolution?.status === "rejected"
    ? t(`ssh.route.${effectiveResolution.code}`)
    : null;

  const suggestions = useMemo(() => {
    const saved = filterSshProfiles(hosts, target);
    const config = filterSshProfiles(configHosts, target);
    return [
      ...saved.map((profile) => ({ profile, source: "saved" as const })),
      ...config.map((profile) => ({ profile, source: "sshConfig" as const })),
    ];
  }, [configHosts, hosts, target]);

  const methodReady = authMethod === "key"
    ? identityFile.trim().length > 0
    : authMethod === "password"
      ? password.length > 0
      : true;
  const jumpReady = !jumpProfileId || Boolean(jumpProfile && (
    jumpAuthMethod === "key"
      ? jumpIdentityFile.trim().length > 0
      : jumpAuthMethod === "password"
        ? jumpPassword.length > 0
        : true
  ));
  const matchedProfile = exactSshProfileMatch(allProfiles, target);
  const resolvedUser = user || matchedProfile?.user || "";
  const resolvedHost = host || matchedProfile?.host || "";
  const canConnect = resolvedHost.length > 0
    && resolvedUser.length > 0
    && (portText.length === 0 || parseSshPort(portText) !== null)
    && methodReady && jumpReady && !routeError && !loadingConfig && !connecting;

  const connect = async (fromSuggestion?: { id: string; source: SshProfileSourceV1 }) => {
    if (connectInFlightRef.current || loadingConfig) return;
    if (fromSuggestion) fillFrom(fromSuggestion.id, fromSuggestion.source);
    const sourceProfiles = fromSuggestion
      ? (fromSuggestion.source === "saved" ? hosts : configHosts)
      : [];
    const suggestion = fromSuggestion
      ? sourceProfiles.find((item) => item.id === fromSuggestion.id)
      : undefined;
    const suggestionResolution = suggestion
      ? resolveSshProfileRoute(suggestion.id, fromSuggestion!.source, panelModel)
      : null;
    const snapshot = suggestionResolution?.status === "ready" ? suggestionResolution.route : undefined;
    const nextTarget = suggestion
      ? formatSshTarget(snapshot?.target.user ?? suggestion.user, snapshot?.target.host ?? suggestion.host, snapshot?.target.port ?? suggestion.port)
      : target;
    const parsed = parseSshTarget(nextTarget);
    const match = suggestion ?? exactSshProfileMatch(allProfiles, nextTarget);
    const nextHost = snapshot?.target.host || parsed?.host || match?.host || "";
    const nextUser = snapshot?.target.user || parsed?.user || match?.user || "";
    const nextAuth = snapshot?.target.authMethod
      ?? (suggestion ? match?.authMethod : undefined)
      ?? authMethod
      ?? "auto";
    const nextIdentity = (snapshot?.target.identityFile
      ?? (suggestion ? match?.identityFile : undefined)
      ?? identityFile) ?? "";
    const nextCertificate = snapshot?.target.certificateFile
      ?? (suggestion ? match?.certificateFile : undefined)
      ?? certificateFile;
    const nextJump = snapshot?.jump ?? jumpProfile;
    const nextJumpAuth = snapshot?.jump?.authMethod ?? jumpAuthMethod;
    const nextJumpIdentity = snapshot?.jump?.identityFile ?? jumpIdentityFile;
    const nextJumpCertificate = snapshot?.jump?.certificateFile ?? jumpCertificateFile;
    const nextRouteError = suggestionResolution?.status === "rejected"
      ? t(`ssh.route.${suggestionResolution.code}`)
      : routeError;
    const nextMethodReady = nextAuth === "key"
      ? nextIdentity.trim().length > 0
      : nextAuth === "password"
        ? password.length > 0
        : true;
    const nextJumpReady = !nextJump || (
      nextJumpAuth === "key"
        ? nextJumpIdentity.trim().length > 0
        : nextJumpAuth === "password"
          ? jumpPassword.length > 0
          : true
    );
    if (!nextHost || !nextUser || !nextMethodReady || !nextJumpReady || nextRouteError) return;
    connectInFlightRef.current = true;
    const attempt = ++connectAttemptRef.current;
    setConnecting(true);
    const safePort = snapshot?.target.port ?? parsed?.port ?? match?.port ?? normalizeSshPort(port);
    // pty-bridge only forwards IdentityFile for `key`. Auto with a known path
    // therefore opens as key so ssh-config / saved IdentityFile still reaches russh.
    const usesKeyMaterial = nextAuth === "key" || (nextAuth === "auto" && nextIdentity.trim().length > 0);
    const sessionAuth: SshAuthMethod = usesKeyMaterial && nextAuth === "auto" ? "key" : nextAuth;
    const trimmedId = sessionAuth === "key" ? nextIdentity.trim() : "";
    const trimmedCertificate = sessionAuth === "key" ? (nextCertificate ?? "").trim() : "";
    const jumpUsesKey = nextJumpAuth === "key" || (nextJumpAuth === "auto" && nextJumpIdentity.trim().length > 0);
    const sessionJumpAuth: SshAuthMethod = jumpUsesKey && nextJumpAuth === "auto" ? "key" : nextJumpAuth;
    const route = nextJump ? { profileId: nextJump.id, jump: {
      host: nextJump.host, port: nextJump.port, user: nextJump.user,
      authMethod: sessionJumpAuth,
      ...(sessionJumpAuth === "key" && nextJumpIdentity.trim() ? { identityFile: nextJumpIdentity.trim() } : {}),
      ...(sessionJumpAuth === "key" && nextJumpCertificate.trim() ? { certificateFile: nextJumpCertificate.trim() } : {}),
    } } : undefined;
    const remote: RemoteInfo = {
      host: nextHost,
      port: safePort,
      user: nextUser,
      authMethod: sessionAuth,
      ...(sessionAuth === "key" && trimmedId ? { identityFile: trimmedId } : {}),
      ...(sessionAuth === "key" && trimmedCertificate ? { certificateFile: trimmedCertificate } : {}),
      injectShellIntegration: injectIntegration,
      ...(autoReconnect ? { autoReconnect: true } : {}),
      ...(route ? { route } : {}),
    };
    const reconnectSessionId = prefill?.reconnectSessionId;
    const existingSession = reconnectSessionId
      ? useSessionsStore.getState().sessions.find((session) => session.id === reconnectSessionId)
      : undefined;
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
      if (forwardSnapshotInFlight.current) {
        connectInFlightRef.current = false;
        setConnecting(false);
        return;
      }
      forwardSnapshotInFlight.current = true;
      try {
        reconnectForwards = await captureSshReconnectForwards(existingSession);
      } catch {
        if (attempt !== connectAttemptRef.current) return;
        useUIStore.getState().addToast({ title: t("ssh.forward.snapshotFailed"), subtitle: "", variant: "error" });
        connectInFlightRef.current = false;
        setConnecting(false);
        return;
      } finally {
        forwardSnapshotInFlight.current = false;
      }
    }

    if (attempt !== connectAttemptRef.current) return;
    stashSshCredentials(session.id, {
      password: sessionAuth === "password" ? password : undefined,
      keyPassphrase: sessionAuth === "key" ? keyPassphrase || undefined : undefined,
      jumpPassword: route && sessionJumpAuth === "password" ? jumpPassword : undefined,
      jumpKeyPassphrase: route && sessionJumpAuth === "key" ? jumpKeyPassphrase || undefined : undefined,
    });
    setPassword("");
    setKeyPassphrase("");
    setJumpPassword("");
    setJumpKeyPassphrase("");
    const selectedSaved = selectedProfile?.source === "saved"
      ? hosts.find((candidate) => candidate.id === selectedProfile.id)
      : undefined;
    const pendingSavedHost = sshHostProfileFromSuccessfulConnect(
      remote,
      match?.label || `${nextUser}@${nextHost}`,
      hosts,
      selectedSaved,
    );

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
        pendingSavedHost,
        runState: "idle",
        startedAt: undefined,
        completedAt: undefined,
        lastExitCode: undefined,
        terminalProgress: undefined,
        pendingInput: undefined,
        pendingInputSubmit: undefined,
        reconnectNonce,
        terminalMountNonce: reconnectNonce,
      });
      useSessionsStore.getState().handleConnectionEvent(existingSession.id, { type: "reconnectRequested" });
      useSessionsStore.getState().setActive(existingSession.id);
    } else {
      addSession({ ...session, pendingSavedHost });
    }
    useUIStore.getState().unlockInspectorView();
    useUIStore.getState().showTerminal();
    setOverlay(null);
    onClose();
  };

  const actions: SshProfilesPanelActionsV1 = {
    onConnect: (_route: SshProfileRouteV1) => { void connect(); },
    onSave: async (profile) => {
      try {
        const savedProfiles = await saveHost(profile);
        setPanelModel((current) => ({ ...current, savedProfiles }));
        useUIStore.getState().bumpSshProfilesEpoch();
      } catch {
        setFormError(t("ssh.profile.save_failed"));
      }
    },
    onRemove: deleteProfile,
    onRefreshConfig: () => refreshConfig(true),
    onOpenConfigDiagnostic: (_diagnostic: SshImportDiagnosticV1) => {
      setAdvancedOpen(true);
      if (diagnosticsRef.current) diagnosticsRef.current.open = true;
      diagnosticsRef.current?.focus();
    },
  };

  const moveHighlight = (delta: number) => {
    if (suggestions.length === 0) return;
    setHighlight((current) => {
      const next = current + delta;
      if (next < 0) return suggestions.length - 1;
      if (next >= suggestions.length) return 0;
      return next;
    });
  };

  const sessionDiagnostics = diagnosticsForSession(prefill?.reconnectSessionId ?? "");

  return (
    <>
      <div aria-hidden="true" onClick={cancelConnect} className="overlay-backdrop" style={{ position: "fixed", inset: 0, background: "var(--backdrop-color)", zIndex: 200 }} />
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ssh-connect-title"
        aria-describedby="ssh-connect-subtitle"
        aria-busy={connecting}
        className="ssh-connect-dialog overlay-sheet"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            cancelConnect();
            return;
          }
          const targetEl = event.target;
          if (targetEl === targetRef.current && event.key === "ArrowDown") {
            event.preventDefault();
            moveHighlight(1);
            return;
          }
          if (targetEl === targetRef.current && event.key === "ArrowUp") {
            event.preventDefault();
            moveHighlight(-1);
            return;
          }
          const excludesSubmit = targetEl instanceof HTMLButtonElement
            || targetEl instanceof HTMLSelectElement
            || targetEl instanceof HTMLTextAreaElement
            || (targetEl instanceof HTMLInputElement && ["checkbox", "radio"].includes(targetEl.type));
          if (event.key === "Enter" && !excludesSubmit) {
            event.preventDefault();
            if (targetEl === targetRef.current && highlight >= 0 && suggestions[highlight]) {
              void connect({ id: suggestions[highlight].profile.id, source: suggestions[highlight].source });
              return;
            }
            if (canConnect) void connect();
          }
        }}
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 480,
          maxWidth: "calc(100vw - 32px)",
          maxHeight: "calc(100dvh - 32px)",
          background: "var(--c-bg-white)",
          borderRadius: "var(--r-overlay)",
          boxShadow: "var(--shadow-overlay)",
          zIndex: 201,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          outline: "none",
        }}
      >
        <div className="ssh-connect-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", borderBottom: "1px solid var(--c-border-2)", flexShrink: 0 }}>
          <span id="ssh-connect-title" style={{ display: "block", fontSize: "var(--fs-title)", fontWeight: 650, color: "var(--c-text-primary)" }}>
            {prefill?.reconnectSessionId ? t("ssh.reconnect.title") : t("ssh.title")}
          </span>
          <span id="ssh-connect-subtitle" className="sr-only">{t("ssh.target_placeholder")}</span>
          <button type="button" onClick={cancelConnect} aria-label={t("common.close")} className="hover-bg" style={{ width: 26, height: 26, border: "none", background: "transparent", cursor: "pointer", color: "var(--c-text-4)", borderRadius: "var(--r-btn)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <CloseIcon />
          </button>
        </div>

        <div style={{ padding: "16px 18px 8px", display: "flex", flexDirection: "column", gap: 10, minHeight: 0, overflow: "auto" }}>
          <label htmlFor="ssh-connect-host" style={labelStyle}>{t("ssh.host")}</label>
          <input
            ref={targetRef}
            id="ssh-connect-host"
            className="ui-control"
            style={fieldStyle}
            value={target}
            placeholder={t("ssh.target_placeholder")}
            aria-invalid={portInvalid}
            aria-describedby={portInvalid ? "ssh-connect-port-error" : undefined}
            onChange={(event) => { setTarget(event.target.value); setHighlight(-1); setSelectedProfile(null); }}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            aria-autocomplete="list"
            aria-controls="ssh-connect-suggestions"
          />
          {portInvalid && (
            <span id="ssh-connect-port-error" role="alert" style={{ fontSize: "var(--fs-meta)", color: "var(--c-warning-text)" }}>
              {t("ssh.port_invalid")}
            </span>
          )}
          {formError && <p role="alert" style={{ color: "var(--c-error)", margin: 0, fontSize: "var(--fs-meta)" }}>{formError}</p>}
          {routeError && <p role="alert" style={{ color: "var(--c-warning-text)", margin: 0 }}>{routeError}</p>}

          <div id="ssh-connect-suggestions" role="listbox" aria-label={t("ssh.source.saved")} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {suggestions.map((entry, index) => (
              <SuggestionRow
                key={`${entry.source}:${entry.profile.id}`}
                profile={entry.profile}
                source={entry.source}
                selected={selectedProfile?.id === entry.profile.id && selectedProfile.source === entry.source}
                active={highlight === index}
                onSelect={() => fillFrom(entry.profile.id, entry.source)}
                onDelete={entry.source === "saved" ? () => { void actions.onRemove(entry.profile.id); } : undefined}
                deletePending={isPending(`ssh-profile:${entry.profile.id}`)}
              />
            ))}
            {target.trim() && suggestions.length === 0 && !loadingConfig && (
              <div style={{ padding: "8px 4px", color: "var(--c-text-5)", fontSize: "var(--fs-meta)" }}>{t("ssh.search_empty")}</div>
            )}
          </div>

          {advancedOpen && (
            <div className="ssh-connect-form" style={{ display: "flex", flexDirection: "column", gap: 12, paddingTop: 8 }}>
              <div>
                <label htmlFor="ssh-connect-port" style={labelStyle}>{t("ssh.port")}</label>
                <input id="ssh-connect-port" className="ui-control" style={fieldStyle} value={port} inputMode="numeric" aria-invalid={portInvalid} aria-describedby={portInvalid ? "ssh-connect-port-error" : undefined} onChange={(event) => setPort(event.target.value)} />
              </div>
              <fieldset style={{ margin: 0, padding: 0, border: "none" }}>
                <legend style={labelStyle}>{t("ssh.auth.method")}</legend>
                <div role="radiogroup" aria-label={t("ssh.auth.method")} style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 6 }}>
                  {AUTH_METHODS.map((method) => (
                    <label key={method} className="hover-bg" style={{ display: "flex", alignItems: "center", gap: 7, padding: "7px 9px", border: `1px solid ${authMethod === method ? "var(--c-accent)" : "var(--c-border-2)"}`, borderRadius: "var(--r-btn)", cursor: "pointer" }}>
                      <input className="ui-choice" type="radio" name="ssh-auth-method" value={method} checked={authMethod === method} onChange={() => chooseAuthMethod(method)} />
                      <span>{t(`ssh.auth.${method}.label`)}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              {authMethod === "password" && (
                <div>
                  <label htmlFor="ssh-connect-password" style={labelStyle}>{t("ssh.password")}</label>
                  <input id="ssh-connect-password" className="ui-control" style={fieldStyle} type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="off" spellCheck={false} />
                </div>
              )}
              {(authMethod === "key" || authMethod === "auto") && (
                <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                  <FileField id="ssh-connect-identity" label={t("ssh.identityFile")} value={identityFile} placeholder={t("ssh.identity_placeholder")} onChange={setIdentityFile} onPick={() => { void pickFile(t("ssh.identity_picker.title"), identityFile, setIdentityFile); }} chooseLabel={t("ssh.identity_picker.choose")} />
                  <div>
                    <label htmlFor="ssh-connect-passphrase" style={labelStyle}>{t("ssh.keyPassphrase")}</label>
                    <input id="ssh-connect-passphrase" className="ui-control" style={fieldStyle} type="password" value={keyPassphrase} onChange={(event) => setKeyPassphrase(event.target.value)} autoComplete="off" spellCheck={false} />
                  </div>
                  <FileField id="ssh-connect-certificate" label={t("ssh.certificateFile")} value={certificateFile} placeholder={t("ssh.certificate_placeholder")} onChange={setCertificateFile} onPick={() => { void pickFile(t("ssh.certificate_picker.title"), certificateFile, setCertificateFile); }} chooseLabel={t("ssh.identity_picker.choose")} />
                </div>
              )}
              <div>
                <label htmlFor="ssh-jump-profile" style={labelStyle}>{t("ssh.route.selector")}</label>
                <select id="ssh-jump-profile" className="ui-control" value={jumpProfileId} style={fieldStyle} onChange={(event) => { setJumpProfileId(event.target.value); setRouteResolution(null); }}>
                  <option value="">{t("ssh.route.direct")}</option>
                  {jumpOptions.map((profile, index) => <option key={`${profile.id}:${index}`} value={profile.id}>{profile.label}</option>)}
                </select>
              </div>
              {jumpProfile && (
                <fieldset style={{ margin: 0, border: "1px solid var(--c-border-2)", borderRadius: "var(--r-btn)", padding: 10 }}>
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
                  {jumpAuthMethod === "password" && <label htmlFor="ssh-jump-password">{t("ssh.route.jump_password")}<input id="ssh-jump-password" className="ui-control" type="password" style={fieldStyle} value={jumpPassword} onChange={(event) => setJumpPassword(event.target.value)} autoComplete="off" spellCheck={false} /></label>}
                  {(jumpAuthMethod === "key" || jumpAuthMethod === "auto") && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 9, marginTop: 8 }}>
                      <FileField id="ssh-jump-identity" label={t("ssh.identityFile")} value={jumpIdentityFile} onChange={setJumpIdentityFile} onPick={() => { void pickFile(t("ssh.identity_picker.title"), jumpIdentityFile, setJumpIdentityFile); }} chooseLabel={t("ssh.identity_picker.choose")} />
                      <label htmlFor="ssh-jump-passphrase">{t("ssh.route.jump_passphrase")}</label>
                      <input id="ssh-jump-passphrase" className="ui-control" type="password" style={fieldStyle} value={jumpKeyPassphrase} onChange={(event) => setJumpKeyPassphrase(event.target.value)} autoComplete="off" spellCheck={false} />
                      <FileField id="ssh-jump-certificate" label={t("ssh.certificateFile")} value={jumpCertificateFile} onChange={setJumpCertificateFile} onPick={() => { void pickFile(t("ssh.certificate_picker.title"), jumpCertificateFile, setJumpCertificateFile); }} chooseLabel={t("ssh.identity_picker.choose")} />
                    </div>
                  )}
                </fieldset>
              )}
              <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer", fontSize: "var(--fs-secondary)" }}>
                <input className="ui-choice" type="checkbox" checked={injectIntegration} onChange={(event) => setInjectIntegration(event.target.checked)} style={{ marginTop: 2 }} />
                <span>{t("ssh.injectIntegration")}<span style={{ display: "block", marginTop: 2, fontSize: "var(--fs-meta)", color: "var(--c-text-4)" }}>{t("ssh.injectIntegrationHint")}</span></span>
              </label>
              <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer", fontSize: "var(--fs-secondary)" }}>
                <input className="ui-choice" type="checkbox" checked={autoReconnect} onChange={(event) => setAutoReconnect(event.target.checked)} style={{ marginTop: 2 }} />
                <span>{t("ssh.autoReconnect")}<span style={{ display: "block", marginTop: 2, fontSize: "var(--fs-meta)", color: "var(--c-text-4)" }}>{t("ssh.autoReconnectHint")}</span></span>
              </label>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                <button type="button" onClick={() => { void actions.onRefreshConfig(); }} disabled={loadingConfig} className="hover-bg" style={{ border: "none", background: "transparent", color: "var(--c-text-4)", fontSize: "var(--fs-meta)", cursor: loadingConfig ? "wait" : "pointer" }}>
                  {loadingConfig ? t("ssh.config.loading") : t("ssh.config.refresh")}
                </button>
                <span role="status" style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)" }}>
                  {t("ssh.config.summary", { available: configHosts.length, skipped: configSkipped })}
                </span>
              </div>
              {(configDiagnostics.length > 0 || configSkipped > 0 || sessionDiagnostics.length > 0) && (
                <details ref={diagnosticsRef} tabIndex={-1} aria-label={t("ssh.config.diagnostics")} className="ssh-config-diagnostics">
                  <summary>{t("ssh.config.diagnostics")}</summary>
                  <p style={{ fontSize: "var(--fs-meta)", lineHeight: 1.45 }}>{t("ssh.config.support_matrix")}</p>
                  <p style={{ fontSize: "var(--fs-meta)", lineHeight: 1.45 }}>{t("ssh.config.never_execute")}</p>
                  {configDiagnostics.map((item, index) => (
                    <button type="button" onClick={() => actions.onOpenConfigDiagnostic(item)} key={`${item.source}:${item.line ?? ""}:${index}`} style={{ display: "block", border: 0, background: "transparent", padding: 0, color: "inherit", fontFamily: "var(--font-mono)", fontSize: "var(--fs-meta)", textAlign: "left" }}>
                      {[item.severity, item.source + (item.line == null ? "" : `:${item.line}`), item.alias, item.code, item.directive].filter((part): part is string => Boolean(part)).join(" · ")}
                    </button>
                  ))}
                </details>
              )}
            </div>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "12px 18px", borderTop: "1px solid var(--c-border-2)", flexShrink: 0 }}>
          <button type="button" className="hover-bg" onClick={() => setAdvancedOpen((openAdvanced) => !openAdvanced)} style={{ border: "none", background: "transparent", color: "var(--c-text-5)", fontSize: "var(--fs-meta)", cursor: "pointer", padding: 0 }}>
            {t("ssh.advanced")}
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={cancelConnect} className="ui-button" style={{ padding: "6px 16px", fontSize: "var(--fs-body)" }}>{t("common.cancel")}</button>
            <button type="button" onClick={() => { void connect(); }} disabled={!canConnect} className="ui-button ui-button--primary" style={{ padding: "6px 18px", fontSize: "var(--fs-body)", fontWeight: 500 }}>
              {connecting ? t("ssh.connecting") : prefill?.reconnectSessionId ? t("terminal.exited.reconnect") : t("ssh.connect")}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
