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
  let oldRemaining = 0;
  let newRemaining = 0;

  return patch.split("\n").map((line) => {
    const i = idx++;
    if (line.startsWith("diff --git ") || (oldRemaining === 0 && newRemaining === 0 && !line.startsWith("\\"))) {
      inHunk = false;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      inHunk = true;
      oldRemaining = Number(hunk[2] ?? 1);
      newRemaining = Number(hunk[4] ?? 1);
      hunkIndex += 1;
      return { key: `hunk:${i}`, line, isAdd: false, isDel: false, isHunk: true, hunkIndex };
    }
    if (!inHunk && (line.startsWith("---") || line.startsWith("+++"))) {
      return { key: `file:${i}`, line, isAdd: false, isDel: false, isHunk: false, hunkIndex };
    }
    if (line.startsWith("+")) {
      if (inHunk) newRemaining -= 1;
      return { key: `new:${i}`, line, isAdd: true, isDel: false, isHunk: false, hunkIndex };
    }
    if (line.startsWith("-")) {
      if (inHunk) oldRemaining -= 1;
      return { key: `old:${i}`, line, isAdd: false, isDel: true, isHunk: false, hunkIndex };
    }
    if (inHunk) {
      if (line.startsWith(" ")) {
        oldRemaining -= 1;
        newRemaining -= 1;
      }
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

export function filterRowsByQuery(rows: DiffRow[], query: string): DiffRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => r.line.toLowerCase().includes(q));
}
