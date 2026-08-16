import type { Session } from "../../ui/types.ts";
import { isAgentActivityBusy } from "../terminal/lib/agent-lifecycle.ts";

export function shouldShowReviewChangesHint(session: Session): boolean {
  if (!session.reviewChangesHint || !session.agent) return false;
  if (isAgentActivityBusy(session.agentActivity)) return false;
  return (session.changes?.files.length ?? 0) > 0;
}
