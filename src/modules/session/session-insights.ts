export const SESSION_NUDGE_COUNT = 6;

export interface ChangeSummaryInput {
  added?: number;
  removed?: number;
  stage?: string;
}

export interface ChangeSummary {
  fileCount: number;
  added: number;
  removed: number;
  staged: number;
  unstaged: number;
  untracked: number;
}

export function summarizeChangedFiles(files: readonly ChangeSummaryInput[] | undefined): ChangeSummary {
  const summary: ChangeSummary = {
    fileCount: 0,
    added: 0,
    removed: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
  };
  if (!files) return summary;

  for (const file of files) {
    summary.fileCount += 1;
    summary.added += safeNonNegativeInt(file.added);
    summary.removed += safeNonNegativeInt(file.removed);
    if (file.stage === "staged") summary.staged += 1;
    else if (file.stage === "untracked") summary.untracked += 1;
    else summary.unstaged += 1;
  }

  return summary;
}

export function pickSessionNudgeIndex(
  seed: string,
  now = Date.now(),
  count = SESSION_NUDGE_COUNT,
): number {
  const safeCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;
  const day = Number.isFinite(now) ? Math.floor(now / 86_400_000) : 0;
  return stableHash(`${seed}:${day}`) % safeCount;
}

function safeNonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
