import { useEffect, useRef, useState } from "react";
import { useSessionsStore, createRemoteSession } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { CloseIcon } from "../shared";
import { useT } from "@/modules/i18n";
import {
  loadHosts,
  saveHost,
  removeHost,
  makeHostId,
  normalizeSshPort,
  parseSshPort,
  importSshConfig,
  filterNewHostsById,
  type SshHostProfile,
} from "@/modules/ssh/hosts-bridge";
import { stashSshCredentials } from "@/modules/ssh/pending-credentials";
import { useFocusTrap } from "./useFocusTrap";
import { useDestructiveConfirm } from "../lib/destructive-confirm";

interface SshConnectProps {
  onClose: () => void;
}

/**
 * 新建 SSH 远程会话对话框。
 * 只采集连接信息——认证走 ssh-agent / 密钥文件 / 临时密码，不持久化任何凭证。
 * Phase 2：可保存为主机 profile（host/port/user/identity，无密码）并复用。
 */
export function SshConnect({ onClose }: SshConnectProps) {
  const t = useT();
  const { isPending, tryConfirm } = useDestructiveConfirm();
  const containerRef = useRef<HTMLDivElement>(null);
  const addSession = useSessionsStore((s) => s.addSession);
  const setOverlay = useUIStore((s) => s.setOverlay);
  // 手敲 ssh 检测带来的预填值（仅 host/user/port，绝不含凭证）。读一次即可，
  // 对话框生命周期内不变；关闭对话框时 setOverlay(null) 会清掉 sshPrefill。
  const prefill = useUIStore.getState().sshPrefill;

  const [host, setHost] = useState(prefill?.host ?? "");
  const [port, setPort] = useState(prefill?.port ? String(prefill.port) : "22");
  const [user, setUser] = useState(prefill?.user ?? "");
  const [identityFile, setIdentityFile] = useState("");
  const [keyPassphrase, setKeyPassphrase] = useState("");
  const [password, setPassword] = useState("");
  const [saveProfile, setSaveProfile] = useState(false);
  // Default-on: integration powers remote cwd + agent status (the OSC 777
  // wrappers that clear the "running" badge when a remote agent exits).
  const [injectIntegration, setInjectIntegration] = useState(true);
  const [hosts, setHosts] = useState<SshHostProfile[]>([]);
  const [importing, setImporting] = useState(false);

  useFocusTrap(containerRef);

  // 自动聚焦首个输入，符合 overlay 进场习惯。
  useEffect(() => {
    containerRef.current?.querySelector("input")?.focus();
  }, []);

  // 载入已保存的主机 profile。
  useEffect(() => {
    loadHosts()
      .then(setHosts)
      .catch(() => {
        setHosts([]);
        useUIStore.getState().addToast({
          title: t("ssh.profile.load_failed"),
          subtitle: "",
          variant: "error",
        });
      });
  }, [t]);

  const fillFrom = (p: SshHostProfile) => {
    setHost(p.host);
    setPort(String(p.port));
    setUser(p.user);
    setIdentityFile(p.identityFile);
  };

  const deleteProfile = (id: string) => {
    tryConfirm(`ssh-profile:${id}`, () => {
      removeHost(id)
        .then(setHosts)
        .catch(() => {
          useUIStore.getState().addToast({
            title: t("ssh.profile.remove_failed"),
            subtitle: "",
            variant: "error",
          });
        });
    });
  };

  // Import static `Host` blocks from ~/.ssh/config. Existing profiles (matched
  // by the stable ssh-config-<alias> id) are NOT overwritten so a user's manual
  // identity_file edits survive re-import; only new aliases are appended.
  const onImportConfig = async () => {
    if (importing) return;
    setImporting(true);
    try {
      const { imported, skipped } = await importSshConfig();
      const fresh = filterNewHostsById(hosts, imported);
      let latest = hosts;
      for (const p of fresh) {
        latest = await saveHost(p);
      }
      setHosts(latest);
      const added = fresh.length;
      useUIStore.getState().addToast({
        title: t("ssh.import.result"),
        subtitle: t("ssh.import.result_detail", { added, skipped }),
        variant: "success",
      });
    } catch {
      useUIStore.getState().addToast({
        title: t("ssh.import.failed"),
        subtitle: "",
        variant: "error",
      });
    } finally {
      setImporting(false);
    }
  };

  const portText = port.trim();
  const portInvalid = portText.length > 0 && parseSshPort(portText) === null;
  const canConnect =
    host.trim().length > 0 &&
    user.trim().length > 0 &&
    (portText.length === 0 || parseSshPort(portText) !== null);

  const connect = () => {
    if (!canConnect) return;
    const safePort = normalizeSshPort(port);
    const trimmedHost = host.trim();
    const trimmedUser = user.trim();
    const trimmedId = identityFile.trim();

    if (saveProfile) {
      // 复用同 host+port+user 的已有 profile id，避免覆盖同主机的另一端口。
      const existing = hosts.find((h) =>
        h.host === trimmedHost && h.port === safePort && h.user === trimmedUser
      );
      void saveHost({
        id: existing?.id ?? makeHostId(),
        label: existing?.label ?? `${trimmedUser}@${trimmedHost}`,
        host: trimmedHost,
        port: safePort,
        user: trimmedUser,
        identityFile: trimmedId,
      }).catch(() => {
        useUIStore.getState().addToast({
          title: t("ssh.profile.save_failed"),
          subtitle: "",
          variant: "error",
        });
      });
    }

    const session = createRemoteSession({
      host: trimmedHost,
      port: safePort,
      user: trimmedUser,
      identityFile: trimmedId || undefined,
      // Explicit boolean (not `|| undefined`): the backend now defaults missing
      // to true, so an opt-OUT must travel as `false` and persist as `false`.
      injectShellIntegration: injectIntegration,
    });
    // Password / passphrase live OUTSIDE the Session object (which is persisted)
    // so credentials are never written to disk — consumed once when the PTY opens.
    stashSshCredentials(session.id, {
      password: password || undefined,
      keyPassphrase: keyPassphrase || undefined,
    });
    addSession(session); // addSession 已将其设为活动会话
    setOverlay(null);
    onClose();
  };

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

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "var(--backdrop-color)",
          backdropFilter: "var(--backdrop-blur)",
          zIndex: 200,
          animation: "fadeIn var(--duration-normal) var(--ease-smooth)",
        }}
      />
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="ssh-connect-title"
        tabIndex={0}
        onKeyDown={(e: React.KeyboardEvent) => {
          if (e.key === "Escape") onClose();
          // B3: Enter (plain or with Cmd/Ctrl) submits the form so keyboard
          // users aren't forced to reach for the mouse. Mirrors HostKeyPrompt
          // and WorkflowParamPrompt, which both bind Enter to their primary
          // action.
          const target = e.target;
          const interactiveControl = target instanceof HTMLButtonElement
            || (target instanceof HTMLInputElement && target.type === "checkbox");
          if (e.key === "Enter" && !interactiveControl) {
            e.preventDefault();
            if (canConnect) connect();
          }
        }}
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 440,
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
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "14px 18px",
            borderBottom: "1px solid var(--c-border-2)",
            flexShrink: 0,
          }}
        >
          <span id="ssh-connect-title" style={{ fontSize: "var(--fs-title)", fontWeight: 600, color: "var(--c-text-primary)" }}>
            {t("ssh.title")}
          </span>
          <button
            onClick={onClose}
            aria-label={t("common.close")}
            className="hover-bg"
            style={{
              width: 26,
              height: 26,
              border: "none",
              background: "transparent",
              cursor: "pointer",
              color: "var(--c-text-4)",
              borderRadius: "var(--r-btn)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <CloseIcon />
          </button>
        </div>

        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14, overflowY: "auto", minHeight: 0 }}>
          <button
            onClick={onImportConfig}
            disabled={importing}
            className="hover-bg"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              padding: "7px 10px",
              borderRadius: "var(--r-btn)",
              border: "1px solid var(--c-border-2)",
              background: "var(--c-bg-white)",
              color: "var(--c-text-2)",
              fontSize: "var(--fs-secondary)",
              fontWeight: 500,
              cursor: importing ? "default" : "pointer",
              opacity: importing ? 0.6 : 1,
            }}
          >
            {t("ssh.import.button")}
          </button>
          {hosts.length > 0 && (
            <div>
              <label style={labelStyle}>{t("ssh.saved")}</label>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 132, overflowY: "auto" }}>
                {hosts.map((h) => (
                  <div
                    key={h.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                      padding: "6px 8px",
                      borderRadius: "var(--r-btn)",
                      border: "1px solid var(--c-border-2)",
                    }}
                  >
                    <button
                      onClick={() => fillFrom(h)}
                      className="hover-bg"
                      style={{
                        flex: 1,
                        minWidth: 0,
                        textAlign: "left",
                        border: "none",
                        background: "transparent",
                        cursor: "pointer",
                        color: "var(--c-text-primary)",
                        fontSize: "var(--fs-body)",
                        padding: "2px 4px",
                        borderRadius: "var(--r-btn)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {h.label || `${h.user}@${h.host}`}
                      <span style={{ color: "var(--c-text-4)", fontSize: "var(--fs-meta)", marginLeft: 6 }}>
                        {h.user}@{h.host}
                        {h.port !== 22 ? `:${h.port}` : ""}
                      </span>
                    </button>
                    <button
                      onClick={() => deleteProfile(h.id)}
                      title={isPending(`ssh-profile:${h.id}`) ? t("destructive.confirm_again") : t("ssh.profile.delete")}
                      aria-label={isPending(`ssh-profile:${h.id}`) ? t("destructive.confirm_again") : t("ssh.profile.delete")}
                      className="hover-close"
                      style={{
                        width: 22,
                        height: 22,
                        flexShrink: 0,
                        border: "none",
                        background: "transparent",
                        cursor: "pointer",
                        color: isPending(`ssh-profile:${h.id}`) ? "var(--c-error)" : "var(--c-text-4)",
                        borderRadius: "var(--r-btn)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                      }}
                    >
                      <CloseIcon />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 3 }}>
              <label htmlFor="ssh-connect-host" style={labelStyle}>{t("ssh.host")}</label>
              <input
                id="ssh-connect-host"
                style={fieldStyle}
                value={host}
                placeholder={t("ssh.host_placeholder")}
                onChange={(e) => setHost(e.target.value)}
                spellCheck={false}
                autoCapitalize="off"
              />
            </div>
            <div style={{ flex: 1 }}>
              <label htmlFor="ssh-connect-port" style={labelStyle}>{t("ssh.port")}</label>
              <input
                id="ssh-connect-port"
                style={fieldStyle}
                value={port}
                inputMode="numeric"
                aria-invalid={portInvalid}
                onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ""))}
              />
            </div>
          </div>

          <div>
            <label htmlFor="ssh-connect-user" style={labelStyle}>{t("ssh.user")}</label>
            <input
              id="ssh-connect-user"
              style={fieldStyle}
              value={user}
              placeholder={t("ssh.user_placeholder")}
              onChange={(e) => setUser(e.target.value)}
              spellCheck={false}
              autoCapitalize="off"
            />
          </div>

          <div>
            <label htmlFor="ssh-connect-identity" style={labelStyle}>{t("ssh.identityFile")}</label>
            <input
              id="ssh-connect-identity"
              style={fieldStyle}
              value={identityFile}
              placeholder={t("ssh.identity_placeholder")}
              onChange={(e) => setIdentityFile(e.target.value)}
              spellCheck={false}
              autoCapitalize="off"
            />
            <span style={{ display: "block", marginTop: 5, fontSize: "var(--fs-meta)", color: "var(--c-text-4)" }}>
              {t("ssh.authHint")}
            </span>
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 1 }}>
              <label htmlFor="ssh-connect-passphrase" style={labelStyle}>{t("ssh.keyPassphrase")}</label>
              <input
                id="ssh-connect-passphrase"
                style={fieldStyle}
                type="password"
                value={keyPassphrase}
                onChange={(e) => setKeyPassphrase(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label htmlFor="ssh-connect-password" style={labelStyle}>{t("ssh.password")}</label>
              <input
                id="ssh-connect-password"
                style={fieldStyle}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>
          <span style={{ display: "block", marginTop: -6, fontSize: "var(--fs-meta)", color: "var(--c-text-4)" }}>
            {t("ssh.credentialsHint")}
          </span>

          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: "var(--fs-secondary)", color: "var(--c-text-primary)" }}>
            <input type="checkbox" checked={saveProfile} onChange={(e) => setSaveProfile(e.target.checked)} />
            {t("ssh.saveProfile")}
          </label>

          <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer", fontSize: "var(--fs-secondary)", color: "var(--c-text-primary)" }}>
            <input type="checkbox" checked={injectIntegration} onChange={(e) => setInjectIntegration(e.target.checked)} style={{ marginTop: 2 }} />
            <span>
              {t("ssh.injectIntegration")}
              <span style={{ display: "block", marginTop: 2, fontSize: "var(--fs-meta)", color: "var(--c-text-4)" }}>
                {t("ssh.injectIntegrationHint")}
              </span>
            </span>
          </label>
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "12px 18px",
            borderTop: "1px solid var(--c-border-2)",
            flexShrink: 0,
          }}
        >
          <button
            onClick={onClose}
            className="hover-bg"
            style={{
              padding: "6px 16px",
              borderRadius: "var(--r-btn)",
              border: "1px solid var(--c-border-2)",
              background: "transparent",
              color: "var(--c-text-primary)",
              fontSize: "var(--fs-body)",
              cursor: "pointer",
            }}
          >
            {t("common.cancel")}
          </button>
          <button
            onClick={connect}
            disabled={!canConnect}
            className="hover-primary"
            style={{
              padding: "6px 18px",
              borderRadius: "var(--r-btn)",
              border: "none",
              background: "var(--c-btn-primary-bg)",
              color: "var(--c-btn-primary-text)",
              fontSize: "var(--fs-body)",
              fontWeight: 500,
              cursor: canConnect ? "pointer" : "not-allowed",
              opacity: canConnect ? 1 : 0.5,
            }}
          >
            {t("ssh.connect")}
          </button>
        </div>
      </div>
    </>
  );
}
