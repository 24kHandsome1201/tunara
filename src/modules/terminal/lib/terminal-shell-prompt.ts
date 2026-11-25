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
      recordWrite(!bracketedPasteActive && (data === "\r" || data === "\n" || data === "\x03"));
    },
    recordMarker(marker: string) {
      // A marker can lag behind input already sent to the shell.
      if (state === "dirty") return;
      if (marker === "A") state = "fresh";
      else if (marker === "C" || marker === "D") state = "awaiting";
    },
  };
}
