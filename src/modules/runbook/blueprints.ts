export interface RunbookBlueprint {
  id: string;
  nameKey: string;
  descriptionKey: string;
  template: string;
}

export const RUNBOOK_BLUEPRINTS: readonly RunbookBlueprint[] = [
  {
    id: "runbook:start",
    nameKey: "runbook.start.name",
    descriptionKey: "runbook.start.description",
    template: "pnpm dev || npm run dev || yarn dev",
  },
  {
    id: "runbook:check",
    nameKey: "runbook.check.name",
    descriptionKey: "runbook.check.description",
    template: "git status --short --branch && pnpm typecheck && pnpm lint",
  },
  {
    id: "runbook:fix",
    nameKey: "runbook.fix.name",
    descriptionKey: "runbook.fix.description",
    template: "pnpm lint --fix || npm run lint -- --fix || true",
  },
  {
    id: "runbook:rollback",
    nameKey: "runbook.rollback.name",
    descriptionKey: "runbook.rollback.description",
    template: "git restore --staged . && git restore .",
  },
  {
    id: "runbook:test",
    nameKey: "runbook.test.name",
    descriptionKey: "runbook.test.description",
    template: "pnpm test || npm test || yarn test",
  },
] as const;

export function appendRunbookToNote(existing: string, template: string): string {
  const block = template.trim();
  if (!block) return existing;
  const trimmed = existing.trimEnd();
  if (!trimmed) return `${block}\n`;
  return `${trimmed}\n\n${block}\n`;
}