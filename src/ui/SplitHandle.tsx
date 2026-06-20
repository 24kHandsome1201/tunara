import { useCallback, useRef } from "react";
import { useUIStore, type SplitMode } from "@/state/ui";

interface SplitHandleProps {
  mode: Exclude<SplitMode, "single">;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

export function SplitHandle({ mode, containerRef }: SplitHandleProps) {
  const setSplitRatio = useUIStore((s) => s.setSplitRatio);
  const dragging = useRef(false);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
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

      const onPointerUp = (ev: PointerEvent) => {
        dragging.current = false;
        (ev.target as HTMLElement).releasePointerCapture(ev.pointerId);
        document.removeEventListener("pointermove", onPointerMove);
        document.removeEventListener("pointerup", onPointerUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.body.style.cursor = mode === "horizontal" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("pointermove", onPointerMove);
      document.addEventListener("pointerup", onPointerUp);
    },
    [mode, containerRef, setSplitRatio],
  );

  const isHorizontal = mode === "horizontal";

  return (
    <div
      onPointerDown={onPointerDown}
      className={`split-handle ${isHorizontal ? "split-handle-h" : "split-handle-v"}`}
      style={{
        position: "relative",
        zIndex: 10,
        ...(isHorizontal
          ? { width: 5, cursor: "col-resize", flexShrink: 0 }
          : { height: 5, cursor: "row-resize", flexShrink: 0 }),
        background: "transparent",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
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
