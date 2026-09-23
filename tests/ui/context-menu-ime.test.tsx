import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ContextMenu } from "@/ui/ContextMenu";
import { getResolvedLanguage, setLanguage } from "@/modules/i18n";

afterEach(() => {
  vi.restoreAllMocks();
});

test("context menu ignores Enter while an IME composition is active", () => {
  const action = vi.fn();
  const onClose = vi.fn();
  render(<ContextMenu items={[{ label: "Rename", action }]} position={{ x: 10, y: 10 }} onClose={onClose} />);
  const menu = screen.getByRole("menu");
  fireEvent.keyDown(menu, { key: "Enter", isComposing: true });
  fireEvent.keyDown(menu, { key: "Enter", keyCode: 229 });
  expect(action).not.toHaveBeenCalled();
  fireEvent.keyDown(menu, { key: "Enter" });
  expect(action).toHaveBeenCalledTimes(1);
});

test("context menu stays inside the viewport with a margin", () => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 300, width: 200, height: 300, toJSON: () => ({}),
  } as DOMRect);
  render(<ContextMenu items={[{ label: "Copy", action: () => {} }]} position={{ x: window.innerWidth - 5, y: 100 }} onClose={() => {}} />);
  const menu = screen.getByRole("menu");
  const left = Number.parseFloat(menu.style.left);
  const top = Number.parseFloat(menu.style.top);
  expect(left + 200).toBeLessThanOrEqual(window.innerWidth - 8);
  expect(top).toBeGreaterThanOrEqual(8);
});

test("document language follows the resolved UI language", () => {
  const previous = getResolvedLanguage();
  setLanguage("zh-CN");
  expect(document.documentElement.lang).toBe("zh-CN");
  setLanguage("en");
  expect(document.documentElement.lang).toBe("en");
  setLanguage(previous);
});
