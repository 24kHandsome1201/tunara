export function nextFilePreview(current: string | null, requested: string): string | null {
  return current === requested ? null : requested;
}

export function filePreviewWillChange(current: string | null, next: string | null): boolean {
  return current !== null && current !== next;
}
