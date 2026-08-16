import type { Session } from "./types";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { useT } from "@/modules/i18n";
import { SessionHintBar } from "./SessionHintBar";

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

  return (
    <SessionHintBar
      actionLabel={t("ssh.suggest.open")}
      onAction={() => {
        useUIStore.getState().openSshConnect(suggestion);
        useSessionsStore.getState().clearSshSuggestion(session.id);
      }}
      dismissLabel={t("ssh.suggest.dismiss")}
      onDismiss={() => useSessionsStore.getState().dismissSshSuggestion(session.id)}
    >
      {t("ssh.suggest.title", { target })}
    </SessionHintBar>
  );
}
