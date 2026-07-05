import type { Session } from "./types";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { useT } from "@/modules/i18n";
import { CloseIcon } from "./shared";
import { AccentActionButton } from "./lib/ui-primitives";

interface SshSuggestionBarProps {
  session: Session;
}

/**
 * 当用户在本地会话里手敲 `ssh ...` 时弹出的轻量建议条:一键改用内置 SSH
 * 新建远程会话(文件浏览器/状态栏/远程 Git 都能原生工作)。可忽略,忽略后
 * 本会话不再就同一 host 打扰。不替用户连接、不开后台连接、不碰凭证。
 */
export function SshSuggestionBar({ session }: SshSuggestionBarProps) {
  const t = useT();
  const suggestion = session.sshSuggestion;
  if (!suggestion) return null;

  const target = suggestion.user ? `${suggestion.user}@${suggestion.host}` : suggestion.host;

  const open = () => {
    useUIStore.getState().openSshConnect(suggestion);
    // 只清掉当前建议条,不拉黑 host:用户若在 SSH 对话框里取消,
    // 再敲同一命令仍应得到提示。拉黑只发生在用户点「×」忽略时。
    useSessionsStore.getState().clearSshSuggestion(session.id);
  };
  const dismiss = () => {
    useSessionsStore.getState().dismissSshSuggestion(session.id);
  };

  return (
    <div
      style={{
        minHeight: "var(--h-inline-bar)",
        margin: "4px 8px 0",
        flexShrink: 0,
        background: "var(--c-bg-1)",
        border: "1px solid var(--c-border-1)",
        borderRadius: "var(--r-btn)",
        display: "flex",
        alignItems: "center",
        padding: "0 6px 0 10px",
        gap: 8,
        animation: "statusBarSlideIn var(--duration-normal) var(--ease-out-expo)",
      }}
    >
      <span
        style={{
          fontSize: "var(--fs-meta)",
          color: "var(--c-text-2)",
          lineHeight: "16px",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {t("ssh.suggest.title", { target })}
      </span>
      <AccentActionButton
        onClick={open}
        title={t("ssh.suggest.open")}
        ariaLabel={t("ssh.suggest.open")}
        style={{ marginLeft: "auto" }}
      >
        {t("ssh.suggest.open")}
      </AccentActionButton>
      <button
        onClick={dismiss}
        aria-label={t("ssh.suggest.dismiss")}
        title={t("ssh.suggest.dismiss")}
        className="hover-bg"
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
  );
}
