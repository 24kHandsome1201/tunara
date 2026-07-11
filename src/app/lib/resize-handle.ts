export interface ResizeHandleKeyInput {
  key: string;
  shiftKey: boolean;
  currentWidth: number;
  minWidth: number;
  maxWidth: number;
  defaultWidth: number;
  direction: 1 | -1;
}

const KEY_STEP = 8;
const KEY_STEP_LARGE = 32;

export function resolveResizeHandleWidth(input: ResizeHandleKeyInput): number | null {
  const step = input.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
  if (input.key === "ArrowLeft") return input.currentWidth - step * input.direction;
  if (input.key === "ArrowRight") return input.currentWidth + step * input.direction;
  if (input.key === "Home") return input.direction === 1 ? input.minWidth : input.maxWidth;
  if (input.key === "End") return input.direction === 1 ? input.maxWidth : input.minWidth;
  if (input.key === "Enter" || input.key === " ") return input.defaultWidth;
  return null;
}
