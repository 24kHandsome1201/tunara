import { useCallback, useLayoutEffect, useState, type RefObject } from "react";

export function useExplorerViewport(
  ref: RefObject<HTMLDivElement | null>,
  key?: string,
  rowsRef?: RefObject<HTMLDivElement | null>,
) {
  const [view, setView] = useState({ top: 0, height: 0 });
  const measure = useCallback(() => {
    const viewport = ref.current;
    if (!viewport) return;
    const top = viewport.scrollTop - (rowsRef?.current?.offsetTop ?? 0);
    const height = viewport.clientHeight;
    setView((current) => current.top === top && current.height === height
      ? current
      : { top, height });
  }, [ref, rowsRef]);

  useLayoutEffect(() => {
    const viewport = ref.current;
    if (!viewport) return;
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    const header = rowsRef?.current?.previousElementSibling;
    if (header) observer.observe(header);
    return () => observer.disconnect();
  }, [key, measure, ref, rowsRef]);

  return { view, measure };
}
