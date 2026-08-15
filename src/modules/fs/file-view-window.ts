export const FILE_VIEW_WINDOWS = ["head", "tail"] as const;
export type FileViewWindow = (typeof FILE_VIEW_WINDOWS)[number];

export function isFileViewWindow(value: unknown): value is FileViewWindow {
  return value === "head" || value === "tail";
}
