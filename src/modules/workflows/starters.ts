import type { Workflow } from "./template";

export interface StarterWorkflowBlueprint {
  id: string;
  nameKey: string;
  descriptionKey: string;
  template: string;
}

export const STARTER_WORKFLOW_BLUEPRINTS: readonly StarterWorkflowBlueprint[] = [
  {
    id: "starter:git-snapshot",
    nameKey: "settings.workflows.starter.git_snapshot.name",
    descriptionKey: "settings.workflows.starter.git_snapshot.description",
    template: "git status --short --branch",
  },
  {
    id: "starter:test",
    nameKey: "settings.workflows.starter.test.name",
    descriptionKey: "settings.workflows.starter.test.description",
    template: "pnpm test || npm test || yarn test",
  },
  {
    id: "starter:todo-scan",
    nameKey: "settings.workflows.starter.todo_scan.name",
    descriptionKey: "settings.workflows.starter.todo_scan.description",
    template: "grep -RIn --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=target \"TODO\\|FIXME\" . | head -120",
  },
  {
    id: "starter:large-files",
    nameKey: "settings.workflows.starter.large_files.name",
    descriptionKey: "settings.workflows.starter.large_files.description",
    template: "find . -type f -size +5M -not -path \"./.git/*\" -not -path \"./node_modules/*\" -not -path \"./target/*\" -print | head -80",
  },
  {
    id: "starter:ports",
    nameKey: "settings.workflows.starter.ports.name",
    descriptionKey: "settings.workflows.starter.ports.description",
    template: "lsof -nP -iTCP -sTCP:LISTEN | head -40",
  },
] as const;

export function makeStarterWorkflows(translate: (key: string) => string): Workflow[] {
  return STARTER_WORKFLOW_BLUEPRINTS.map((starter) => ({
    id: starter.id,
    name: translate(starter.nameKey),
    description: translate(starter.descriptionKey),
    template: starter.template,
  }));
}

export function missingStarterWorkflows(existing: readonly Workflow[], translate: (key: string) => string): Workflow[] {
  const existingIds = new Set(existing.map((workflow) => workflow.id));
  const existingTemplates = new Set(existing.map((workflow) => workflow.template.trim()));
  return makeStarterWorkflows(translate).filter((workflow) =>
    !existingIds.has(workflow.id) && !existingTemplates.has(workflow.template.trim()),
  );
}
