import { useCallback, useRef } from "react";
import { useUIStore, type SplitMode } from "@/state/ui";

interface SplitHandleProps {
  mode: Exclude<SplitMode, "single">;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

export function SplitHandle({ mode, containerRef }: SplitHandleProps) {
  const setSplitRatio = useUIStore((s) => s.setSplitRatio);
  const dragging = useRef(false);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragging.current = true;
      const container = containerRef.current;
      if (!container) return;

      const onMouseMove = (ev: MouseEvent) => {
        if (!dragging.current || !container) return;
        const rect = container.getBoundingClientRect();
        const ratio =
          mode === "horizontal"
            ? (ev.clientX - rect.left) / rect.width
            : (ev.clientY - rect.top) / rect.height;
        setSplitRatio(ratio);
      };

      const onMouseUp = () => {
        dragging.current = false;
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.body.style.cursor = mode === "horizontal" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [mode, containerRef, setSplitRatio],
  );

  const isHorizontal = mode === "horizontal";

  return (
    <div
      onMouseDown={onMouseDown}
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
        style={{
          ...(isHorizontal
            ? { width: 1, height: "100%" }
            : { height: 1, width: "100%" }),
          background: "var(--c-border-1)",
        }}
      />
    </div>
  );
}
