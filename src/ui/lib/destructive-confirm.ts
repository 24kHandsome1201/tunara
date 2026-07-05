import { useCallback, useEffect, useReducer, useRef, useState } from "react";

/** Shared window for "click again to confirm" destructive actions. */
export const DESTRUCTIVE_CONFIRM_WINDOW_MS = 3_000;

export function getDestructiveConfirmRemainingMs(
  confirmedAt: number,
  now = Date.now(),
  windowMs = DESTRUCTIVE_CONFIRM_WINDOW_MS,
): number {
  if (confirmedAt <= 0) return 0;
  return Math.max(0, windowMs - (now - confirmedAt));
}

export function getDestructiveConfirmRemainingSeconds(confirmedAt: number, now = Date.now()): number {
  return Math.ceil(getDestructiveConfirmRemainingMs(confirmedAt, now) / 1000);
}

export function useDestructiveConfirmCountdown(confirmedAt: number) {
  const [now, setNow] = useState(Date.now);
  const active = confirmedAt > 0;

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [active, confirmedAt]);

  if (!active) return null;
  const remainingMs = getDestructiveConfirmRemainingMs(confirmedAt, now);
  if (remainingMs <= 0) return null;
  return {
    remainingMs,
    remainingSeconds: Math.ceil(remainingMs / 1000),
    progress: remainingMs / DESTRUCTIVE_CONFIRM_WINDOW_MS,
  };
}

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