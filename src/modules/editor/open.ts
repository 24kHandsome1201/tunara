import { invoke } from "@tauri-apps/api/core";

export function openInEditor(editor: string, path: string, line?: number) {
  return invoke<void>("open_in_editor", { editor, path, line });
}
