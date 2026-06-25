import { useCallback, useRef } from "react";
import { useUIStore, type SplitMode } from "@/state/ui";

interface SplitHandleProps {
  mode: Exclude<SplitMode, "single">;
  containerRef: React.RefObject<HTMLDivElement | null>;
  order?: number;
}

const KEY_STEP = 0.02;
const KEY_STEP_LARGE = 0.1;

export function SplitHandle({ mode, containerRef, order }: SplitHandleProps) {
  const setSplitRatio = useUIStore((s) => s.setSplitRatio);
  const ratio = useUIStore((s) => s.split.ratio);
  const dragging = useRef(false);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const isHorizontal = mode === "horizontal";
      const decKey = isHorizontal ? "ArrowLeft" : "ArrowUp";
      const incKey = isHorizontal ? "ArrowRight" : "ArrowDown";
      if (e.key === decKey) {
        e.preventDefault();
        setSplitRatio(ratio - (e.shiftKey ? KEY_STEP_LARGE : KEY_STEP));
      } else if (e.key === incKey) {
        e.preventDefault();
        setSplitRatio(ratio + (e.shiftKey ? KEY_STEP_LARGE : KEY_STEP));
      } else if (e.key === "Home") {
        e.preventDefault();
        setSplitRatio(0.2);
      } else if (e.key === "End") {
        e.preventDefault();
        setSplitRatio(0.8);
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setSplitRatio(0.5);
      }
    },
    [mode, ratio, setSplitRatio],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const handle = e.currentTarget as HTMLElement;
      handle.setPointerCapture(e.pointerId);
      dragging.current = true;
      const container = containerRef.current;
      if (!container) return;

      const onPointerMove = (ev: PointerEvent) => {
        if (!dragging.current || !container) return;
        const rect = container.getBoundingClientRect();
        const ratio =
          mode === "horizontal"
            ? (ev.clientX - rect.left) / rect.width
            : (ev.clientY - rect.top) / rect.height;
        setSplitRatio(ratio);
      };

      const cleanup = (ev: PointerEvent) => {
        dragging.current = false;
        if (handle.hasPointerCapture(ev.pointerId)) {
          handle.releasePointerCapture(ev.pointerId);
        }
        document.removeEventListener("pointermove", onPointerMove);
        document.removeEventListener("pointerup", cleanup);
        document.removeEventListener("pointercancel", cleanup);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.body.style.cursor = mode === "horizontal" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("pointermove", onPointerMove);
      document.addEventListener("pointerup", cleanup);
      document.addEventListener("pointercancel", cleanup);
    },
    [mode, containerRef, setSplitRatio],
  );

  const isHorizontal = mode === "horizontal";

  return (
    <div
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      role="separator"
      tabIndex={0}
      aria-orientation={isHorizontal ? "vertical" : "horizontal"}
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={20}
      aria-valuemax={80}
      aria-label={isHorizontal ? "拖动调整左右分栏比例（方向键、Shift+方向键大幅、Home/End 极值、Enter 居中）" : "拖动调整上下分栏比例（方向键、Shift+方向键大幅、Home/End 极值、Enter 居中）"}
      className={`split-handle ${isHorizontal ? "split-handle-h" : "split-handle-v"}`}
      style={{
        position: "relative",
        zIndex: 10,
        order,
        ...(isHorizontal
          ? { width: 5, cursor: "col-resize", flexShrink: 0 }
          : { height: 5, cursor: "row-resize", flexShrink: 0 }),
        background: "transparent",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        outline: "none",
      }}
    >
      <div
        className="split-handle-line"
        style={{
          ...(isHorizontal
            ? { width: 1, height: "100%" }
            : { height: 1, width: "100%" }),
          background: "var(--c-border-1)",
          transition: `background var(--duration-fast) ease, ${isHorizontal ? "width" : "height"} var(--duration-fast) ease`,
        }}
      />
    </div>
  );
}
