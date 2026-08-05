import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent } from "react";

export interface ContextMenuPoint {
  x: number;
  y: number;
}

interface ContextMenuTriggerOptions {
  onOpen: (point: ContextMenuPoint) => void;
  disabled?: boolean;
  longPressMs?: number;
  movementTolerance?: number;
}

/** Pointer/touch helper for host UI. Do not attach this to the terminal canvas. */
export function useContextMenuTrigger<T extends HTMLElement>({
  onOpen,
  disabled = false,
  longPressMs = 550,
  movementTolerance = 10,
}: ContextMenuTriggerOptions) {
  const timerRef = useRef<number | null>(null);
  const startRef = useRef<ContextMenuPoint | null>(null);
  const firedRef = useRef(false);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;

  const cancel = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    startRef.current = null;
  };
  useEffect(() => cancel, []);

  return {
    onPointerDown(event: PointerEvent<T>) {
      if (disabled || event.pointerType !== "touch" || !event.isPrimary) return;
      const nestedControl = (event.target as Element | null)?.closest("button,a,input,select,textarea,[role=button]");
      if (nestedControl && nestedControl !== event.currentTarget) return;
      const point = { x: event.clientX, y: event.clientY };
      startRef.current = point;
      firedRef.current = false;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        firedRef.current = true;
        openRef.current(point);
      }, longPressMs);
    },
    onPointerMove(event: PointerEvent<T>) {
      const start = startRef.current;
      if (!start) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > movementTolerance) cancel();
    },
    onPointerUp(event: PointerEvent<T>) {
      if (firedRef.current) event.preventDefault();
      cancel();
    },
    onPointerCancel: cancel,
    onClickCapture(event: MouseEvent<T>) {
      if (!firedRef.current) return;
      firedRef.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
    onKeyDown(event: KeyboardEvent<T>) {
      if (disabled || !(event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey))) return false;
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      openRef.current({ x: rect.left + Math.min(16, rect.width / 2), y: rect.top + rect.height / 2 });
      return true;
    },
  };
}
