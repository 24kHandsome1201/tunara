import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { t } from "../../i18n/core.ts";
import { fsExportTextFile } from "../../fs/fs-bridge.ts";
import { useUIStore } from "../../../state/ui.ts";
import { clipTerminalExportText, collectTerminalBufferText, type TerminalExportBuffer } from "./terminal-export.ts";

export const TERMINAL_EXPORT_SCROLLBACK_EVENT = "tunara:export-scrollback";

export function requestTerminalScrollbackExport(sessionId: string): void {
  window.dispatchEvent(new CustomEvent(TERMINAL_EXPORT_SCROLLBACK_EVENT, { detail: { sessionId } }));
}

export async function exportTerminalTextToFile(
  raw: string,
  defaultPath: string,
  sessionId?: string,
): Promise<"saved" | "cancelled" | "error"> {
  const clipped = clipTerminalExportText(raw);
  if (!clipped.text) {
    useUIStore.getState().addToast({
      sessionId,
      title: t("term.export.empty"),
      subtitle: t("term.export.empty_hint"),
      variant: "warning",
    });
    return "cancelled";
  }
  try {
    const destination = await saveDialog({
      title: t("term.export.choose_destination"),
      defaultPath,
      filters: [{ name: "Text", extensions: ["txt", "log"] }],
    });
    if (!destination) return "cancelled";
    const bytes = await fsExportTextFile(destination, clipped.text);
    useUIStore.getState().addToast({
      sessionId,
      title: t("term.export.saved"),
      subtitle: clipped.truncated
        ? t("term.export.truncated", { lines: clipped.lineCount })
        : t("term.export.size", { size: bytes }),
      variant: "success",
    });
    return "saved";
  } catch {
    useUIStore.getState().addToast({
      sessionId,
      title: t("term.export.failed"),
      subtitle: t("term.export.failed_hint"),
      variant: "error",
    });
    return "error";
  }
}

export async function exportTerminalBufferToFile(
  buffer: TerminalExportBuffer | null | undefined,
  defaultPath: string,
  sessionId?: string,
): Promise<"saved" | "cancelled" | "error"> {
  if (!buffer) {
    useUIStore.getState().addToast({
      sessionId,
      title: t("term.export.empty"),
      subtitle: t("term.export.empty_hint"),
      variant: "warning",
    });
    return "cancelled";
  }
  return exportTerminalTextToFile(collectTerminalBufferText(buffer).text, defaultPath, sessionId);
}
