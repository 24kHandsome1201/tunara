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

function safeNonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}
