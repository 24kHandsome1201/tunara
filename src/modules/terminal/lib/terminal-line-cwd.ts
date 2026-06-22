export interface TerminalLineCwdMarker {
  readonly line: number;
  readonly isDisposed: boolean;
  dispose(): void;
}

interface TerminalLineCwdMark {
  cwd: string;
  marker: TerminalLineCwdMarker;
}

export function createTerminalLineCwdTracker() {
  let marks: TerminalLineCwdMark[] = [];

  const pruneDisposed = () => {
    marks = marks.filter(({ marker }) => !marker.isDisposed && marker.line >= 0);
  };

  return {
    record(cwd: string, marker: TerminalLineCwdMarker) {
      const normalized = cwd.trim();
      if (!normalized) {
        marker.dispose();
        return;
      }
      pruneDisposed();
      const last = marks[marks.length - 1];
      if (last?.cwd === normalized) {
        marker.dispose();
        return;
      }
      if (last?.marker.line === marker.line) {
        last.marker.dispose();
        marks[marks.length - 1] = { cwd: normalized, marker };
        return;
      }
      marks.push({ cwd: normalized, marker });
    },

    getCwdForLine(bufferLineNumber: number, fallback?: string) {
      pruneDisposed();
      const targetLine = Math.max(0, Math.floor(bufferLineNumber) - 1);
      for (let i = marks.length - 1; i >= 0; i -= 1) {
        if (marks[i].marker.line <= targetLine) return marks[i].cwd;
      }
      return fallback;
    },

    dispose() {
      for (const { marker } of marks) marker.dispose();
      marks = [];
    },
  };
}
