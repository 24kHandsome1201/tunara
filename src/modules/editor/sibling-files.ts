export interface SiblingEntry {
  name: string;
  kind: "file" | "dir" | "symlink";
}

export function parentDirectoryPath(path: string): string {
  if (!path || path === "/") return "/";
  const trimmed = path.endsWith("/") && path.length > 1 ? path.slice(0, -1) : path;
  const slash = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (slash <= 0) return trimmed.startsWith("/") ? "/" : ".";
  return trimmed.slice(0, slash) || "/";
}

function joinChild(parent: string, name: string): string {
  if (!parent || parent === "/" || parent === ".") return parent === "." ? name : `/${name}`;
  return parent.endsWith("/") || parent.endsWith("\\") ? `${parent}${name}` : `${parent}/${name}`;
}

export function siblingPreviewPaths(
  currentPath: string,
  entries: readonly SiblingEntry[],
): { previous: string | null; next: string | null; files: string[] } {
  const parent = parentDirectoryPath(currentPath);
  const files = entries
    .filter((entry) => entry.kind === "file" && entry.name && !entry.name.includes("/") && !entry.name.includes("\\"))
    .map((entry) => joinChild(parent, entry.name));
  const index = files.indexOf(currentPath);
  if (index < 0) return { previous: null, next: null, files };
  return {
    previous: index > 0 ? files[index - 1] : null,
    next: index < files.length - 1 ? files[index + 1] : null,
    files,
  };
}
