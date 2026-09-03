export const CODE_SYNTAX_KINDS = [
  "keyword",
  "string",
  "number",
  "comment",
  "function",
  "type",
  "variable",
  "property",
  "operator",
  "punctuation",
  "tag",
  "attribute",
] as const;

export type CodeSyntaxKind = (typeof CODE_SYNTAX_KINDS)[number];

function startsWithScope(scope: string, prefix: string): boolean {
  return scope === prefix || scope.startsWith(`${prefix}.`);
}

function kindFromScopeName(scope: string): CodeSyntaxKind | null {
  if (startsWithScope(scope, "comment") || startsWithScope(scope, "punctuation.definition.comment")) {
    return "comment";
  }
  if (startsWithScope(scope, "string") || startsWithScope(scope, "constant.character.escape")) {
    return "string";
  }
  if (
    startsWithScope(scope, "constant.numeric")
    || startsWithScope(scope, "constant.character.numeric")
    || startsWithScope(scope, "constant.other.numeric")
  ) {
    return "number";
  }
  if (
    startsWithScope(scope, "entity.name.function")
    || startsWithScope(scope, "support.function")
    || startsWithScope(scope, "entity.name.method")
  ) {
    return "function";
  }
  if (
    startsWithScope(scope, "entity.name.type")
    || startsWithScope(scope, "entity.name.class")
    || startsWithScope(scope, "entity.name.struct")
    || startsWithScope(scope, "entity.name.enum")
    || startsWithScope(scope, "entity.name.interface")
    || startsWithScope(scope, "support.type")
    || startsWithScope(scope, "support.class")
  ) {
    return "type";
  }
  if (startsWithScope(scope, "entity.name.tag") || startsWithScope(scope, "entity.name.section")) {
    return "tag";
  }
  if (startsWithScope(scope, "entity.other.attribute-name")) return "attribute";
  if (
    startsWithScope(scope, "variable.other.property")
    || startsWithScope(scope, "variable.object.property")
    || startsWithScope(scope, "support.type.property-name")
    || startsWithScope(scope, "meta.object-literal.key")
    || startsWithScope(scope, "entity.name.tag.yaml")
    || startsWithScope(scope, "support.type.property-name.json")
  ) {
    return "property";
  }
  if (startsWithScope(scope, "variable") || startsWithScope(scope, "support.variable")) {
    return "variable";
  }
  if (startsWithScope(scope, "keyword.operator") || startsWithScope(scope, "storage.modifier.import")) {
    return "operator";
  }
  if (
    startsWithScope(scope, "keyword")
    || startsWithScope(scope, "storage")
    || startsWithScope(scope, "constant.language")
  ) {
    return "keyword";
  }
  if (startsWithScope(scope, "punctuation") || startsWithScope(scope, "meta.brace")) {
    return "punctuation";
  }
  return null;
}

/** Map a TextMate scope stack (root → most specific) onto a fixed syntax kind. */
export function kindFromScopes(scopes: readonly string[]): CodeSyntaxKind | "text" {
  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    const kind = kindFromScopeName(scopes[index]);
    if (kind) return kind;
  }
  return "text";
}
