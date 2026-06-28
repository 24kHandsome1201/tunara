export function hasOwnRecordKey(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

export function hasTrueRecordKey(record: Record<string, true>, key: string): boolean {
  return hasOwnRecordKey(record, key) && record[key] === true;
}

export function getNumberRecordValue(record: Record<string, number>, key: string, fallback = 0): number {
  if (!hasOwnRecordKey(record, key)) return fallback;
  const value = record[key];
  return Number.isFinite(value) ? value : fallback;
}

export function toggleTrueRecordKey(record: Record<string, true>, key: string): Record<string, true> {
  if (hasTrueRecordKey(record, key)) {
    const { [key]: _omitted, ...rest } = record;
    return rest;
  }
  return { ...record, [key]: true };
}
