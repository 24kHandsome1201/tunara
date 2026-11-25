import { useEffect, useRef, useState } from "react";
import { Tooltip } from "../Tooltip";

/**
 * Entry name that ellipsizes in narrow panels and reveals the full name in a
 * tooltip while its tree row is hovered or keyboard-focused. The row (not the
 * name) owns hover and roving focus, so listeners attach to the closest
 * treeitem; unclipped names never show a tooltip.
 */
export function ExplorerEntryName({ name }: { name: string }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const text = textRef.current;
    const row = text?.closest<HTMLElement>("[role=treeitem]");
    if (!text || !row) return;
    const reveal = () => setOpen(text.scrollWidth > text.clientWidth);
    const conceal = () => setOpen(false);
    const onFocus = (event: FocusEvent) => {
      if (event.target === row && row.matches(":focus-visible")) reveal();
    };
    row.addEventListener("mouseenter", reveal);
    row.addEventListener("mouseleave", conceal);
    row.addEventListener("focus", onFocus);
    row.addEventListener("blur", conceal);
    row.addEventListener("wheel", conceal, { passive: true });
    return () => {
      row.removeEventListener("mouseenter", reveal);
      row.removeEventListener("mouseleave", conceal);
      row.removeEventListener("focus", onFocus);
      row.removeEventListener("blur", conceal);
      row.removeEventListener("wheel", conceal);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  return (
    <Tooltip label={name} open={open} style={{ minWidth: 0, pointerEvents: "none" }}>
      <span ref={textRef} className="explorer-listing-label">{name}</span>
    </Tooltip>
  );
}
