import { clearMocks } from "@tauri-apps/api/mocks";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { resetEditorDraftRegistryForTests } from "@/modules/editor/editor-draft-registry";
import { setLanguage } from "@/modules/i18n";
import { useSessionsStore } from "@/state/sessions";

beforeEach(() => {
  setLanguage("en");
  resetEditorDraftRegistryForTests();
  useSessionsStore.setState({ activeSessionId: "ui-test-session" });
});

afterEach(() => {
  cleanup();
  clearMocks();
});
