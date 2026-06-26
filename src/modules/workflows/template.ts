// Pure helpers for command-template workflows. A workflow is a named, reusable
// command with optional `{{param}}` placeholders the user fills in before it
// runs. Deliberately minimal: single command, simple {{name}} substitution —
// no multi-step sequences, no conditionals, no expression engine. (Keeping it
// "a bit more than an alias, never bloated".)

export interface WorkflowParam {
  key: string;
  /** Optional default value pre-filled in the param prompt. */
  default?: string;
}

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  /** Command text with `{{param}}` placeholders. */
  template: string;
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/**
 * Extract the ordered, de-duplicated parameter keys referenced in a template.
 * `echo {{a}} {{b}} {{a}}` → [{key:"a"}, {key:"b"}].
 */
export function extractParams(template: string): WorkflowParam[] {
  const seen = new Set<string>();
  const params: WorkflowParam[] = [];
  for (const match of template.matchAll(PLACEHOLDER)) {
    const key = match[1];
    if (!seen.has(key)) {
      seen.add(key);
      params.push({ key });
    }
  }
  return params;
}

/**
 * Substitute `{{param}}` placeholders with the provided values. Missing values
 * become the empty string. Unknown placeholders left in `values` are ignored.
 */
export function applyParams(template: string, values: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (_full, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : "",
  );
}

/** Whether a template has any placeholders (i.e. needs the param prompt). */
export function hasParams(template: string): boolean {
  PLACEHOLDER.lastIndex = 0;
  return PLACEHOLDER.test(template);
}

export function makeWorkflowId(): string {
  // No Math.random in some sandboxes; combine time + a module counter.
  return `wf-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;
}
let idCounter = 1;

/** Validate/normalize a raw persisted workflow; returns null if unusable. */
export function sanitizeWorkflow(raw: unknown): Workflow | null {
  if (!raw || typeof raw !== "object") return null;
  const w = raw as Record<string, unknown>;
  if (typeof w.id !== "string" || !w.id) return null;
  if (typeof w.name !== "string" || !w.name.trim()) return null;
  if (typeof w.template !== "string" || !w.template.trim()) return null;
  const out: Workflow = { id: w.id, name: w.name.trim(), template: w.template };
  if (typeof w.description === "string" && w.description.trim()) {
    out.description = w.description.trim();
  }
  return out;
}
