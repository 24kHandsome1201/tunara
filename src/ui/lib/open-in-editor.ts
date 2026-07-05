import { openInEditor } from "@/modules/editor/open";
import { t } from "@/modules/i18n";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";

export function resolveToastSessionId(sessionId?: string): string | undefined {
  if (sessionId) return sessionId;
  const st = useSessionsStore.getState();
  return st.activeSessionId ?? st.sessions[0]?.id;
}

export function openInEditorWithToast(
  editor: string,
  path: string,
  opts?: { sessionId?: string; line?: number; column?: number },
): Promise<void> {
  const sessionId = resolveToastSessionId(opts?.sessionId);
  return openInEditor(editor, path, opts?.line, opts?.column).catch(() => {
    if (!sessionId) return;
    useUIStore.getState().addToast({
      sessionId,
      title: t("diff.toast.editor_not_found"),
      subtitle: editor,
      variant: "error",
    });
  });
}