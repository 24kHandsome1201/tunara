import { clearMocks } from "@tauri-apps/api/mocks";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { resetEditorDraftRegistryForTests } from "@/modules/editor/editor-draft-registry";
import { setLanguage } from "@/modules/i18n";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { resetDirtyDraftGuardForTests } from "@/modules/editor/dirty-draft-guard";

beforeEach(() => {
  setLanguage("en");
  resetEditorDraftRegistryForTests();
  resetDirtyDraftGuardForTests();
  useSessionsStore.setState({ activeSessionId: "ui-test-session" });
  useUIStore.setState({ presentationMode: "workspace", fileTabs: [], activeFileTabId: null });
});

afterEach(() => {
  cleanup();
  clearMocks();
});
