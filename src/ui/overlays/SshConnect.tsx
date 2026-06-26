import { useEffect, useRef, useState } from "react";
import { useSessionsStore, createRemoteSession } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { CloseIcon } from "../shared";
import { useT } from "@/modules/i18n";

interface SshConnectProps {
  onClose: () => void;
}

/**
 * 新建 SSH 远程会话对话框（Phase 1）。
 * 只采集连接信息——认证走 ssh-agent / 密钥文件 / 临时密码，不持久化任何凭证。
 * 主机 profile 的保存与列表是 Phase 2。
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

  // 自动聚焦首个输入，符合 overlay 进场习惯。
  useEffect(() => {
    containerRef.current?.querySelector("input")?.focus();
  }, []);

  const canConnect = host.trim().length > 0 && user.trim().length > 0;

  const connect = () => {
    if (!canConnect) return;
    const parsedPort = Number.parseInt(port, 10);
    const session = createRemoteSession({
      host: host.trim(),
      port: Number.isFinite(parsedPort) && parsedPort > 0 ? parsedPort : 22,
      user: user.trim(),
      identityFile: identityFile.trim() || undefined,
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
