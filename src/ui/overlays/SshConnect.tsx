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
  type SshHostProfile,
} from "@/modules/ssh/hosts-bridge";

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
  const containerRef = useRef<HTMLDivElement>(null);
  const addSession = useSessionsStore((s) => s.addSession);
  const setOverlay = useUIStore((s) => s.setOverlay);

  const [host, setHost] = useState("");
  const [port, setPort] = useState("22");
  const [user, setUser] = useState("");
  const [identityFile, setIdentityFile] = useState("");
  const [saveProfile, setSaveProfile] = useState(false);
  const [injectIntegration, setInjectIntegration] = useState(false);
  const [hosts, setHosts] = useState<SshHostProfile[]>([]);

  // 自动聚焦首个输入，符合 overlay 进场习惯。
  useEffect(() => {
    containerRef.current?.querySelector("input")?.focus();
  }, []);

  // 载入已保存的主机 profile。
  useEffect(() => {
    loadHosts()
      .then(setHosts)
      .catch(() => setHosts([]));
  }, []);

  const fillFrom = (p: SshHostProfile) => {
    setHost(p.host);
    setPort(String(p.port));
    setUser(p.user);
    setIdentityFile(p.identityFile);
  };

  const deleteProfile = (id: string) => {
    removeHost(id)
      .then(setHosts)
      .catch(() => {});
  };

  const canConnect = host.trim().length > 0 && user.trim().length > 0;

  const connect = () => {
    if (!canConnect) return;
    const parsedPort = Number.parseInt(port, 10);
    const safePort = Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 22;
    const trimmedHost = host.trim();
    const trimmedUser = user.trim();
    const trimmedId = identityFile.trim();

    if (saveProfile) {
      // 复用同 host+user 的已有 profile id，避免重复条目。
      const existing = hosts.find((h) => h.host === trimmedHost && h.user === trimmedUser);
      void saveHost({
        id: existing?.id ?? makeHostId(),
        label: existing?.label ?? `${trimmedUser}@${trimmedHost}`,
        host: trimmedHost,
        port: safePort,
        user: trimmedUser,
        identityFile: trimmedId,
      }).catch(() => {});
    }

    const session = createRemoteSession({
      host: trimmedHost,
      port: safePort,
      user: trimmedUser,
      identityFile: trimmedId || undefined,
      injectShellIntegration: injectIntegration || undefined,
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
        tabIndex={0}
        onKeyDown={(e: React.KeyboardEvent) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) connect();
        }}
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 440,
          maxWidth: "calc(100vw - 32px)",
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
          }}
        >
          <span style={{ fontSize: "var(--fs-title)", fontWeight: 600, color: "var(--c-text-primary)" }}>
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

        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
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
                      <span style={{ color: "var(--c-text-4)", fontSize: "var(--fs-caption)", marginLeft: 6 }}>
                        {h.user}@{h.host}
                        {h.port !== 22 ? `:${h.port}` : ""}
                      </span>
                    </button>
                    <button
                      onClick={() => deleteProfile(h.id)}
                      aria-label={t("common.close")}
                      className="hover-close"
                      style={{
                        width: 22,
                        height: 22,
                        flexShrink: 0,
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
                ))}
              </div>
            </div>
          )}

          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 3 }}>
              <label style={labelStyle}>{t("ssh.host")}</label>
              <input
                style={fieldStyle}
                value={host}
                placeholder="example.com"
                onChange={(e) => setHost(e.target.value)}
                spellCheck={false}
                autoCapitalize="off"
              />
            </div>
            <div style={{ flex: 1 }}>
              <label style={labelStyle}>{t("ssh.port")}</label>
              <input
                style={fieldStyle}
                value={port}
                inputMode="numeric"
                onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ""))}
              />
            </div>
          </div>

          <div>
            <label style={labelStyle}>{t("ssh.user")}</label>
            <input
              style={fieldStyle}
              value={user}
              placeholder="root"
              onChange={(e) => setUser(e.target.value)}
              spellCheck={false}
              autoCapitalize="off"
            />
          </div>

          <div>
            <label style={labelStyle}>{t("ssh.identityFile")}</label>
            <input
              style={fieldStyle}
              value={identityFile}
              placeholder="~/.ssh/id_ed25519"
              onChange={(e) => setIdentityFile(e.target.value)}
              spellCheck={false}
              autoCapitalize="off"
            />
            <span style={{ display: "block", marginTop: 5, fontSize: "var(--fs-caption)", color: "var(--c-text-4)" }}>
              {t("ssh.authHint")}
            </span>
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: "var(--fs-secondary)", color: "var(--c-text-primary)" }}>
            <input type="checkbox" checked={saveProfile} onChange={(e) => setSaveProfile(e.target.checked)} />
            {t("ssh.saveProfile")}
          </label>

          <label style={{ display: "flex", alignItems: "flex-start", gap: 8, cursor: "pointer", fontSize: "var(--fs-secondary)", color: "var(--c-text-primary)" }}>
            <input type="checkbox" checked={injectIntegration} onChange={(e) => setInjectIntegration(e.target.checked)} style={{ marginTop: 2 }} />
            <span>
              {t("ssh.injectIntegration")}
              <span style={{ display: "block", marginTop: 2, fontSize: "var(--fs-caption)", color: "var(--c-text-4)" }}>
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
