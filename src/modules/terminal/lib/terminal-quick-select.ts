const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;

function trimUrlToken(token: string): string {
  let text = token;
  while (/[.,;:!?]$/.test(text)) text = text.slice(0, -1);
  const pairs = [["(", ")"], ["[", "]"], ["{", "}"]] as const;
  let changed = true;
  while (changed) {
    changed = false;
    for (const [open, close] of pairs) {
      if (!text.endsWith(close)) continue;
      const opens = [...text].filter((char) => char === open).length;
      const closes = [...text].filter((char) => char === close).length;
      if (closes > opens) {
        text = text.slice(0, -1);
        changed = true;
      }
    }
  }
  return text;
}

/** Extract http(s) URLs from terminal output for Preview source detection. */
export function findTerminalUrlTokens(text: string): string[] {
  URL_RE.lastIndex = 0;
  const tokens: string[] = [];
  for (const match of text.matchAll(URL_RE)) {
    const token = trimUrlToken(match[0]);
    if (token) tokens.push(token);
  }
  return tokens;
}
