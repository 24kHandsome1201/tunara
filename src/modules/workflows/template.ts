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

// Workflow variables v2 are additive; the four functions above keep their exact
// old behavior so existing call sites/tests are untouched.
//
// New placeholder forms, all backward compatible:
//   {{name}}            text param (prompted)
//   {{name=Default}}    text param with a pre-filled default
//   {{date}} {{time}} {{datetime}} {{cwd}} {{branch}} {{uuid}}
//                       dynamic built-ins resolved automatically, never prompted
//
// The UI uses `promptableParams` (fields to show) + `resolveTemplate` (final
// command). `resolveTemplate` is a strict superset of `applyParams`: with no
// defaults/built-ins it produces byte-identical output.

/** Reserved names auto-filled from context instead of prompting the user. */
export const BUILTIN_VARS = new Set(["date", "time", "datetime", "cwd", "branch", "uuid"]);

// Captures the key and an optional `=default`. Whitespace around both is trimmed.
const PLACEHOLDER_V2 = /\{\{\s*([a-zA-Z0-9_]+)\s*(?:=\s*([^}]*?))?\s*\}\}/g;

/** Values the dynamic built-ins resolve against. All fields optional. */
export interface DynamicContext {
  cwd?: string;
  branch?: string;
  /** Epoch ms for {{date}}/{{time}}/{{datetime}} (defaults to now). */
  now?: number;
  /** Injected for deterministic tests; defaults to crypto/random. */
  uuid?: () => string;
}

function defaultUuid(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `id-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;
}

function pad(n: number): string {
  return `${n}`.padStart(2, "0");
}

/** Resolve a built-in variable name, or null if it isn't one. */
export function resolveBuiltin(name: string, ctx: DynamicContext = {}): string | null {
  if (!BUILTIN_VARS.has(name)) return null;
  const d = new Date(ctx.now ?? Date.now());
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  switch (name) {
    case "date":
      return date;
    case "time":
      return time;
    case "datetime":
      return `${date} ${time}`;
    case "cwd":
      return ctx.cwd ?? "";
    case "branch":
      return ctx.branch ?? "";
    case "uuid":
      return (ctx.uuid ?? defaultUuid)();
    default:
      return null;
  }
}

/**
 * All params in a template (ordered, de-duplicated), with `default` populated
 * from `{{name=default}}`. Includes built-ins too; use `promptableParams` to
 * get just the ones that need a field.
 */
export function parseTemplateParams(template: string): WorkflowParam[] {
  const seen = new Set<string>();
  const params: WorkflowParam[] = [];
  for (const match of template.matchAll(PLACEHOLDER_V2)) {
    const key = match[1];
    if (seen.has(key)) continue;
    seen.add(key);
    const param: WorkflowParam = { key };
    if (match[2] !== undefined) param.default = match[2];
    params.push(param);
  }
  return params;
}

/** Params the user should be prompted for (everything except built-ins). */
export function promptableParams(template: string): WorkflowParam[] {
  return parseTemplateParams(template).filter((p) => !BUILTIN_VARS.has(p.key));
}

/** Whether running this template needs the param prompt (has non-built-ins). */
export function hasPromptableParams(template: string): boolean {
  return promptableParams(template).length > 0;
}

/**
 * Final command text. For each placeholder: built-ins resolve from `ctx`;
 * otherwise a provided non-empty value wins, then the `{{name=default}}`
 * default, then the empty string.
 */
export function resolveTemplate(
  template: string,
  values: Record<string, string>,
  ctx: DynamicContext = {},
): string {
  return template.replace(PLACEHOLDER_V2, (_full, key: string, def?: string) => {
    const builtin = resolveBuiltin(key, ctx);
    if (builtin !== null) return builtin;
    const provided = Object.prototype.hasOwnProperty.call(values, key) ? values[key] : "";
    if (provided !== "" && provided !== undefined) return provided;
    return def ?? "";
  });
}

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
