import { open } from "@tauri-apps/plugin-dialog";
import { t } from "@/modules/i18n";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import {
  createDirectoryTerminalController,
  directoryPickerDefaultPath,
} from "./new-terminal-directory-controller";

const directoryTerminalController = createDirectoryTerminalController({
  pickDirectory: async (defaultPath) => {
    const selected = await open({
      directory: true,
      multiple: false,
      title: t("terminal.directory_picker.title"),
      ...(defaultPath ? { defaultPath } : {}),
    });
    return typeof selected === "string" ? selected : null;
  },
  createTerminal: (directory) => {
    useSessionsStore.getState().newTerminalInDir(directory);
  },
  onFailure: () => {
    useUIStore.getState().addToast({
      title: t("terminal.directory_picker.failed"),
      subtitle: t("terminal.directory_picker.failed_detail"),
      variant: "error",
    });
  },
});

export function openNewTerminalDirectoryDialog() {
  const sessions = useSessionsStore.getState();
  const active = sessions.sessions.find((session) => session.id === sessions.activeSessionId);
  return directoryTerminalController.choose(directoryPickerDefaultPath(active));
}
