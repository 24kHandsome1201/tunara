export interface DropListingNode {
  path: string;
  parentPath: string | null;
  kind: "file" | "dir" | "symlink";
}

export function dropDestinationFromListing(options: {
  clientY: number;
  listTop: number;
  scrollTop: number;
  inset: number;
  rowHeight: number;
  nodes: readonly DropListingNode[];
  currentPath: string;
}): { path: string; highlightPath: string | null } {
  const { clientY, listTop, scrollTop, inset, rowHeight, nodes, currentPath } = options;
  if (!Number.isFinite(clientY) || rowHeight <= 0 || nodes.length === 0) {
    return { path: currentPath, highlightPath: null };
  }
  const y = clientY - listTop + scrollTop - inset;
  const index = Math.floor(y / rowHeight);
  if (index < 0 || index >= nodes.length) return { path: currentPath, highlightPath: null };
  const node = nodes[index];
  if (node.kind === "dir") return { path: node.path, highlightPath: node.path };
  return { path: node.parentPath ?? currentPath, highlightPath: node.parentPath };
}
