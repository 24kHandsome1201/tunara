import { openInEditor } from "@/modules/editor/open";
import { t } from "@/modules/i18n";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { errorToast } from "./error-toast";

export function resolveToastSessionId(sessionId?: string): string | undefined {
  if (sessionId) return sessionId;
  const st = useSessionsStore.getState();
  return st.activeSessionId ?? st.sessions[0]?.id;
}

export function openInEditorWithToast(
  editor: string,
  path: string,
  opts?: { sessionId?: string; line?: number; column?: number },
): Promise<boolean> {
  const sessionId = resolveToastSessionId(opts?.sessionId);
  return openInEditor(editor, path, opts?.line, opts?.column).then(() => true).catch((error: unknown) => {
    if (!sessionId) return false;
    useUIStore.getState().addToast(errorToast({
      sessionId,
      title: t("diff.toast.editor_not_found"),
      next: t("diff.toast.editor_not_found_hint"),
      error,
      action: { kind: "open-settings", tab: "terminal", label: t("common.open_settings") },
    }));
    return false;
  });
}
