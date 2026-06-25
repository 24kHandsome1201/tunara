export interface DiffRow {
  key: string;
  line: string;
  isAdd: boolean;
  isDel: boolean;
  isHunk: boolean;
  hunkIndex: number;
}

export function buildMiniDiffRows(patch: string): DiffRow[] {
  let inHunk = false;
  let idx = 0;
  let hunkIndex = -1;

  return patch.split("\n").map((line) => {
    const i = idx++;
    if (/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.test(line)) {
      inHunk = true;
      hunkIndex += 1;
      return { key: `hunk:${i}`, line, isAdd: false, isDel: false, isHunk: true, hunkIndex };
    }
    if (line.startsWith("---") || line.startsWith("+++")) {
      return { key: `file:${i}`, line, isAdd: false, isDel: false, isHunk: false, hunkIndex };
    }
    if (line.startsWith("+")) {
      return { key: `new:${i}`, line, isAdd: true, isDel: false, isHunk: false, hunkIndex };
    }
    if (line.startsWith("-")) {
      return { key: `old:${i}`, line, isAdd: false, isDel: true, isHunk: false, hunkIndex };
    }
    if (inHunk) {
      return { key: `ctx:${i}`, line, isAdd: false, isDel: false, isHunk: false, hunkIndex };
    }
    return { key: `prelude:${i}`, line, isAdd: false, isDel: false, isHunk: false, hunkIndex };
  });
}

export function collectHunkTexts(rows: DiffRow[]): string[] {
  const buckets: string[][] = [];
  for (const row of rows) {
    if (row.hunkIndex < 0) continue;
    if (!buckets[row.hunkIndex]) buckets[row.hunkIndex] = [];
    buckets[row.hunkIndex].push(row.line);
  }
  return buckets.map((lines) => lines.join("\n"));
}
