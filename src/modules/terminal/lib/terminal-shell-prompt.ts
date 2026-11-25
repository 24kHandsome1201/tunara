export function createShellPromptTracker() {
  let state: "awaiting" | "fresh" | "dirty" = "awaiting";
  const recordWrite = (submit: boolean) => {
    state = submit ? "awaiting" : "dirty";
  };
  return {
    isFresh: () => state === "fresh",
    reset: () => { state = "awaiting"; },
    recordWrite,
    recordInput(data: string, bracketedPasteActive: boolean) {
      const last = data.at(-1);
      const submittedLine = (last === "\r" || last === "\n") && !/[\u0000-\u001f\u007f-\u009f]/.test(data.slice(0, -1));
      recordWrite(!bracketedPasteActive && (submittedLine || data === "\x03"));
    },
    recordMarker(marker: string) {
      // A marker can lag behind input already sent to the shell.
      if (state === "dirty") return;
      if (marker === "A") state = "fresh";
      else if (marker === "C" || marker === "D") state = "awaiting";
    },
  };
}
