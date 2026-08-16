export function canResumeRecovery(record: {
  bytes: number;
  commitIntent: boolean;
  partial?: { path?: string };
}): boolean {
  return record.bytes > 0
    && !record.commitIntent
    && typeof record.partial?.path === "string"
    && record.partial.path.length > 0;
}
