import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_KEYBINDINGS,
  KEYBINDING_ACTIONS,
  sanitizeKeybindings,
} from "../src/modules/config/keybindings.ts";

test("sanitizeKeybindings migrates the legacy attention chord and drops deleted ids", () => {
  const sanitized = sanitizeKeybindings({
    focus_latest_attention: "Mod+Shift+U",
    new_terminal_alt: "Mod+N",
    cycle_next_session: "Mod+Tab",
    cycle_prev_session: "Mod+Shift+Tab",
    navigate_prev_block: "Mod+Shift+ArrowUp",
    navigate_next_block: "Mod+Shift+ArrowDown",
    close_session: "Alt+Q",
  });

  assert.equal(sanitized.focusLatestAttention, "Mod+Enter");
  assert.equal(sanitized.closeSession, "Alt+Q");
  assert.equal("newTerminalAlt" in sanitized, false);
  assert.equal("cycleNextSession" in sanitized, false);
  assert.equal("cyclePrevSession" in sanitized, false);
  assert.equal("navigatePrevBlock" in sanitized, false);
  assert.equal("navigateNextBlock" in sanitized, false);
  assert.deepEqual(
    Object.keys(sanitized).sort(),
    [...KEYBINDING_ACTIONS].sort(),
  );
});

test("camelCase legacy attention chord also migrates", () => {
  const sanitized = sanitizeKeybindings({
    focusLatestAttention: "Mod+Shift+U",
  });
  assert.equal(sanitized.focusLatestAttention, DEFAULT_KEYBINDINGS.focusLatestAttention);
});

test("a custom attention chord other than Mod+Shift+U is kept", () => {
  const sanitized = sanitizeKeybindings({
    focus_latest_attention: "Mod+Shift+A",
  });
  assert.equal(sanitized.focusLatestAttention, "Mod+Shift+A");
});
