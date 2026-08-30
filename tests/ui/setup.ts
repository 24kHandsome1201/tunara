import { clearMocks } from "@tauri-apps/api/mocks";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { resetEditorDraftRegistryForTests } from "@/modules/editor/editor-draft-registry";
import { setLanguage } from "@/modules/i18n";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { resetDirtyDraftGuardForTests } from "@/modules/editor/dirty-draft-guard";
import { resetTerminalBindingsForTests } from "@/modules/terminal/lib/binding-aware-async-action";
import { resetAppLifecycleForTests } from "@/app/app-lifecycle";

beforeEach(() => {
  setLanguage("en");
  resetEditorDraftRegistryForTests();
  resetDirtyDraftGuardForTests();
  resetTerminalBindingsForTests();
  resetAppLifecycleForTests();
  useSessionsStore.setState({ activeSessionId: "ui-test-session" });
  useUIStore.setState({ presentationMode: "workspace", mainSurface: "terminal", fileTabs: [], activeFileTabId: null, terminalWallpaperEnabled: false, terminalWallpaperSource: "paper" });
});

afterEach(() => {
  cleanup();
  clearMocks();
});
