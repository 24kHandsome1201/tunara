export function dedupeConsecutiveLabelParts(parts: readonly string[]): string[] {
  const result: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    if (result[result.length - 1]?.toLowerCase() === part.toLowerCase()) continue;
    result.push(part);
  }
  return result;
}
