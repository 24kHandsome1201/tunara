/**
 * APG tabs 模式的共享键盘漫游工具（自动激活变体）：
 * ArrowLeft/Right/Up/Down 循环移动，Home/End 跳到两端。
 * 选中动作（setState）由调用方完成，焦点跟随选中。
 */

/** 给定当前 tab id 与按键，返回下一个应激活的 tab id；不认识的键返回 null。 */
export function resolveRovingTabId(tabIds: readonly string[], currentId: string, key: string): string | null {
  const index = tabIds.indexOf(currentId);
  if (index === -1 || tabIds.length === 0) return null;
  if (key === "ArrowRight" || key === "ArrowDown") return tabIds[(index + 1) % tabIds.length] ?? null;
  if (key === "ArrowLeft" || key === "ArrowUp") return tabIds[(index - 1 + tabIds.length) % tabIds.length] ?? null;
  if (key === "Home") return tabIds[0] ?? null;
  if (key === "End") return tabIds[tabIds.length - 1] ?? null;
  return null;
}

/** 从事件目标向上找所属 tab 的 data-tab-id；不在任何 tab 上时返回 null。 */
export function tabIdFromEventTarget(target: EventTarget | null): string | null {
  if (!(target instanceof HTMLElement)) return null;
  return target.closest("[data-tab-id]")?.getAttribute("data-tab-id") ?? null;
}

/**
 * 下一帧把焦点移到指定 tab（等 roving tabIndex 先随渲染更新）。
 * data-tab-id 可以挂在按钮本体，也可以挂在包含按钮的 wrapper 上
 * （此时聚焦其内部第一个 button，如 Titlebar 的 .tab-select）。
 */
export function focusTabById(container: HTMLElement | null, tabId: string) {
  requestAnimationFrame(() => {
    const host = container?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(tabId)}"]`);
    if (!host) return;
    const target = host.tagName === "BUTTON" ? host : host.querySelector<HTMLElement>("button");
    target?.focus();
  });
}
