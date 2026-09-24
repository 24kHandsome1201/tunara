import { describe, expect, test } from "vitest";
import { formatShortcutFor } from "@/ui/formatShortcut";

describe("formatShortcutFor", () => {
  test("title-cases named keys on Windows/Linux instead of shouting them", () => {
    expect(formatShortcutFor("Mod+Enter", false)).toBe("Ctrl+Enter");
    expect(formatShortcutFor("Shift+Enter", false)).toBe("Shift+Enter");
    expect(formatShortcutFor("Escape", false)).toBe("Esc");
    expect(formatShortcutFor("Shift+F10", false)).toBe("Shift+F10");
    expect(formatShortcutFor("Ctrl+Shift+k", false)).toBe("Ctrl+Shift+K");
    expect(formatShortcutFor("Mod+Shift+\\", false)).toBe("Ctrl+Shift+\\");
    expect(formatShortcutFor("Mod++", false)).toBe("Ctrl++");
    expect(formatShortcutFor("Alt+ArrowLeft", false)).toBe("Alt+←");
  });

  test("uses macOS glyphs for modifiers and named keys", () => {
    expect(formatShortcutFor("Mod+Enter", true)).toBe("⌘↩");
    expect(formatShortcutFor("Mod+Shift+D", true)).toBe("⌘⇧D");
    expect(formatShortcutFor("Cmd+Alt+t", true)).toBe("⌘⌥T");
    expect(formatShortcutFor("Escape", true)).toBe("⎋");
    expect(formatShortcutFor("Mod+,", true)).toBe("⌘,");
  });
});
