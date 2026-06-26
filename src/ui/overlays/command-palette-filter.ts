export type CommandPaletteScope = "action" | "app" | "batch" | "recent" | "session" | "terminal" | "workflow";

export interface CommandPaletteFilterItem {
  label: string;
  subtitle?: string;
  section: string;
  scopes: readonly CommandPaletteScope[];
}

export interface CommandPaletteRankItem extends CommandPaletteFilterItem {
  id: string;
  originalIndex: number;
}

export interface CommandPaletteParsedQuery {
  text: string;
  normalizedText: string;
  scope?: CommandPaletteScope;
}

const SCOPE_ALIASES: Record<string, CommandPaletteScope> = {
  a: "action",
  action: "action",
  actions: "action",
  app: "app",
  apps: "app",
  batch: "batch",
  recent: "recent",
  r: "recent",
  s: "session",
  session: "session",
  sessions: "session",
  t: "terminal",
  term: "terminal",
  terminal: "terminal",
  w: "workflow",
  wf: "workflow",
  workflow: "workflow",
  workflows: "workflow",
};

export function parseCommandPaletteQuery(rawQuery: string): CommandPaletteParsedQuery {
  const trimmed = rawQuery.trim();
  const prefixMatch = /^([a-z_]+):\s*(.*)$/i.exec(trimmed);
  if (!prefixMatch) return normalizeQueryText(trimmed);

  const scope = SCOPE_ALIASES[prefixMatch[1].toLowerCase()];
  if (!scope) return normalizeQueryText(trimmed);

  return {
    ...normalizeQueryText(prefixMatch[2]),
    scope,
  };
}

export function filterCommandPaletteItems<T extends CommandPaletteFilterItem>(
  items: readonly T[],
  parsedQuery: CommandPaletteParsedQuery,
): T[] {
  return items.filter((item) => {
    if (parsedQuery.scope && !item.scopes.includes(parsedQuery.scope)) return false;
    if (!parsedQuery.normalizedText) return true;
    return commandPaletteItemMatches(item, parsedQuery.normalizedText);
  });
}

export function rankCommandPaletteItems<T extends CommandPaletteRankItem>(
  items: readonly T[],
  parsedQuery: CommandPaletteParsedQuery,
  usage: Record<string, number>,
): T[] {
  return [...items].sort((a, b) => {
    if (parsedQuery.normalizedText) {
      const ia = labelMatchIndex(a, parsedQuery.normalizedText);
      const ib = labelMatchIndex(b, parsedQuery.normalizedText);
      if (ia !== ib) return ia - ib;
    }

    const ua = usage[a.id] ?? 0;
    const ub = usage[b.id] ?? 0;
    if (ua !== ub) return ub - ua;
    return a.originalIndex - b.originalIndex;
  });
}

function normalizeQueryText(text: string): CommandPaletteParsedQuery {
  return {
    text,
    normalizedText: text.toLowerCase(),
  };
}

function commandPaletteItemMatches(item: CommandPaletteFilterItem, normalizedText: string): boolean {
  return (
    item.label.toLowerCase().includes(normalizedText) ||
    item.subtitle?.toLowerCase().includes(normalizedText) === true ||
    item.section.toLowerCase().includes(normalizedText)
  );
}

function labelMatchIndex(item: CommandPaletteFilterItem, normalizedText: string): number {
  const index = item.label.toLowerCase().indexOf(normalizedText);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}
