import { useCallback, useRef } from "react";
import { useUIStore } from "@/state/ui";
import { useT } from "@/modules/i18n";
import type { SplitDirection, SplitPath, SplitRect } from "@/modules/session/split-layout";

interface SplitHandleProps {
  direction: SplitDirection;
  path: SplitPath;
  ratio: number;
  nodeRect: SplitRect;
  containerRef: React.RefObject<HTMLDivElement | null>;
}

const KEY_STEP = 0.02;
const KEY_STEP_LARGE = 0.1;

export function SplitHandle({ direction, path, ratio, nodeRect, containerRef }: SplitHandleProps) {
  const t = useT();
  const setSplitRatio = useUIStore((s) => s.setSplitRatio);
  const dragging = useRef(false);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const isHorizontal = direction === "horizontal";
      const decKey = isHorizontal ? "ArrowLeft" : "ArrowUp";
      const incKey = isHorizontal ? "ArrowRight" : "ArrowDown";
      if (e.key === decKey) {
        e.preventDefault();
        setSplitRatio(path, ratio - (e.shiftKey ? KEY_STEP_LARGE : KEY_STEP));
      } else if (e.key === incKey) {
        e.preventDefault();
        setSplitRatio(path, ratio + (e.shiftKey ? KEY_STEP_LARGE : KEY_STEP));
      } else if (e.key === "Home") {
        e.preventDefault();
        setSplitRatio(path, 0.2);
      } else if (e.key === "End") {
        e.preventDefault();
        setSplitRatio(path, 0.8);
      } else if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setSplitRatio(path, 0.5);
      }
    },
    [direction, path, ratio, setSplitRatio],
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
        const nodeLeft = rect.left + nodeRect.x * rect.width;
        const nodeTop = rect.top + nodeRect.y * rect.height;
        const nodeWidth = nodeRect.width * rect.width;
        const nodeHeight = nodeRect.height * rect.height;
        const ratio =
          direction === "horizontal"
            ? (ev.clientX - nodeLeft) / nodeWidth
            : (ev.clientY - nodeTop) / nodeHeight;
        setSplitRatio(path, ratio);
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

      document.body.style.cursor = direction === "horizontal" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("pointermove", onPointerMove);
      document.addEventListener("pointerup", cleanup);
      document.addEventListener("pointercancel", cleanup);
    },
    [direction, path, nodeRect, containerRef, setSplitRatio],
  );

  const isHorizontal = direction === "horizontal";
  const boundary = isHorizontal
    ? nodeRect.x + nodeRect.width * ratio
    : nodeRect.y + nodeRect.height * ratio;

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
      aria-label={isHorizontal ? t("split.handle.horizontal") : t("split.handle.vertical")}
      className={`split-handle ${isHorizontal ? "split-handle-h" : "split-handle-v"}`}
      style={{
        position: "absolute",
        zIndex: 10,
        ...(isHorizontal
          ? {
              left: `calc(${boundary * 100}% - 2.5px)`,
              top: `${nodeRect.y * 100}%`,
              width: 5,
              height: `${nodeRect.height * 100}%`,
              cursor: "col-resize",
            }
          : {
              left: `${nodeRect.x * 100}%`,
              top: `calc(${boundary * 100}% - 2.5px)`,
              width: `${nodeRect.width * 100}%`,
              height: 5,
              cursor: "row-resize",
            }),
        background: "transparent",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        // 不要再 inline outline:"none" —— 全局 :focus-visible 焦点环靠它生效，
        // 线条高亮由 .split-handle:focus-visible .split-handle-line 负责
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
