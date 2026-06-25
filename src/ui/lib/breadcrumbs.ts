export interface BreadcrumbSegment {
  label: string;
  targetPath: string;
  isCollapsed?: boolean;
}

export function breadcrumbSegments(currentPath: string, rootDir: string): BreadcrumbSegment[] {
  const rootLabel = rootDir === "/" ? "/" : rootDir.split("/").filter(Boolean).pop() || rootDir;
  const rootSeg: BreadcrumbSegment = { label: rootLabel, targetPath: rootDir };

  if (currentPath === rootDir) return [rootSeg];

  let relativeParts: string[] = [];
  if (rootDir !== "/" && currentPath.startsWith(rootDir + "/")) {
    relativeParts = currentPath.slice(rootDir.length + 1).split("/").filter(Boolean);
  } else {
    relativeParts = currentPath.split("/").filter(Boolean);
  }

  const tailSegs: BreadcrumbSegment[] = relativeParts.map((label, idx) => {
    const prefix = rootDir === "/" ? "" : rootDir;
    const targetPath = prefix + "/" + relativeParts.slice(0, idx + 1).join("/");
    return { label, targetPath };
  });

  const all = [rootSeg, ...tailSegs];
  if (all.length <= 4) return all;

  const lastThree = all.slice(-3);
  const collapseTarget = all[all.length - 4];
  return [
    { label: "…", targetPath: collapseTarget.targetPath, isCollapsed: true },
    ...lastThree,
  ];
}
