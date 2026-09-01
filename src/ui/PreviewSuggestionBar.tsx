import type { Session } from "./types";
import { useSessionsStore } from "@/state/sessions";
import { useT } from "@/modules/i18n";
import { latestPreviewPromptSource, previewSourceKey } from "@/modules/preview/preview-source";
import { previewDisplayUrl } from "@/modules/preview/preview-window";
import { openInspectorTab } from "./lib/open-inspector";
import { SessionHintBar } from "./SessionHintBar";

interface PreviewSuggestionBarProps {
  session: Session;
}

export function PreviewSuggestionBar({ session }: PreviewSuggestionBarProps) {
  const t = useT();
  const source = latestPreviewPromptSource(session.previewSources, session.dismissedPreviewKeys);
  if (!source) return null;

  const url = previewDisplayUrl(source.sourceUrl);
  const acknowledge = () => {
    useSessionsStore.getState().dismissPreviewPrompt(session.id, previewSourceKey(source));
  };

  return (
    <SessionHintBar
      actionLabel={t("preview.suggest.open")}
      onAction={() => {
        acknowledge();
        useSessionsStore.getState().setActive(session.id);
        openInspectorTab("preview", session.id);
      }}
      dismissLabel={t("preview.suggest.dismiss")}
      onDismiss={acknowledge}
    >
      {t("preview.suggest.title", { url })}
    </SessionHintBar>
  );
}
