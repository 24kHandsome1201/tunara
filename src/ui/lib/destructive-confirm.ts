import { useCallback, useReducer, useRef } from "react";

/** Shared window for "click again to confirm" destructive actions. */
export const DESTRUCTIVE_CONFIRM_WINDOW_MS = 3_000;

export function isDestructiveConfirmPending(
  store: Map<string, number>,
  key: string,
  now = Date.now(),
): boolean {
  const last = store.get(key) ?? 0;
  return last > 0 && now - last <= DESTRUCTIVE_CONFIRM_WINDOW_MS;
}

/**
 * Returns true when the action should proceed (second click within the window).
 * Returns false on the first click and arms the confirmation timer.
 */
export function requestDestructiveConfirm(
  store: Map<string, number>,
  key: string,
  onExpire: () => void,
): boolean {
  const now = Date.now();
  const last = store.get(key) ?? 0;
  if (last > 0 && now - last <= DESTRUCTIVE_CONFIRM_WINDOW_MS) {
    store.delete(key);
    onExpire();
    return true;
  }
  store.set(key, now);
  setTimeout(() => {
    if (store.get(key) === now) {
      store.delete(key);
      onExpire();
    }
  }, DESTRUCTIVE_CONFIRM_WINDOW_MS);
  return false;
}

/** React hook for delete buttons and other in-component destructive actions. */
export function useDestructiveConfirm() {
  const storeRef = useRef(new Map<string, number>());
  const [, bump] = useReducer((n: number) => n + 1, 0);

  const isPending = useCallback((key: string) => {
    return isDestructiveConfirmPending(storeRef.current, key);
  }, []);

  const tryConfirm = useCallback((key: string, action: () => void): boolean => {
    const confirmed = requestDestructiveConfirm(storeRef.current, key, bump);
    if (confirmed) action();
    return confirmed;
  }, [bump]);

  return { isPending, tryConfirm };
}