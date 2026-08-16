import type { Session } from "./types";
import { useSessionsStore } from "@/state/sessions";
import { useT } from "@/modules/i18n";
import { shouldShowReviewChangesHint } from "@/modules/session/review-changes-hint";
import { openInspectorTab } from "./lib/open-inspector";
import { SessionHintBar } from "./SessionHintBar";

interface ReviewChangesBarProps {
  session: Session;
}

export function ReviewChangesBar({ session }: ReviewChangesBarProps) {
  const t = useT();
  if (!shouldShowReviewChangesHint(session)) return null;

  const count = session.changes?.files.length ?? 0;
  const dismiss = () => {
    useSessionsStore.getState().updateSession(session.id, { reviewChangesHint: false });
  };

  return (
    <SessionHintBar
      actionLabel={t("review.suggest.open")}
      onAction={() => {
        dismiss();
        useSessionsStore.getState().setActive(session.id);
        openInspectorTab("changes");
      }}
      dismissLabel={t("review.suggest.dismiss")}
      onDismiss={dismiss}
    >
      {t("review.suggest.title", { count })}
    </SessionHintBar>
  );
}
