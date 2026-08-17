import { clearMocks } from "@tauri-apps/api/mocks";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { resetEditorDraftRegistryForTests } from "@/modules/editor/editor-draft-registry";
import { setLanguage } from "@/modules/i18n";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { resetDirtyDraftGuardForTests } from "@/modules/editor/dirty-draft-guard";
import { resetTerminalBindingsForTests } from "@/modules/terminal/lib/binding-aware-async-action";
import { hydrateLocalUsageLoggingEnabled } from "@/modules/usage-log/local-usage-log";

beforeEach(() => {
  setLanguage("en");
  resetEditorDraftRegistryForTests();
  resetDirtyDraftGuardForTests();
  resetTerminalBindingsForTests();
  hydrateLocalUsageLoggingEnabled(false);
  useSessionsStore.setState({ activeSessionId: "ui-test-session" });
  useUIStore.setState({ presentationMode: "workspace", fileTabs: [], activeFileTabId: null, localUsageLoggingEnabled: false, terminalWallpaperEnabled: false, terminalWallpaperSource: "paper" });
});

afterEach(() => {
  cleanup();
  clearMocks();
});
