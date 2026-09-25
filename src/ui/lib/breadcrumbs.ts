export interface BreadcrumbSegment {
  label: string;
  targetPath: string;
  isCollapsed?: boolean;
}

function rootDisplayLabel(rootDir: string): string {
  if (rootDir === "/") return "/";
  return rootDir;
}

/** When `homeDir` contains `currentPath`, the trail starts at `~` instead of `/`. */
export function breadcrumbSegments(currentPath: string, rootDir: string, homeDir: string | null = null): BreadcrumbSegment[] {
  if (homeDir && homeDir !== "/" && homeDir.startsWith("/") && (currentPath === homeDir || currentPath.startsWith(homeDir + "/"))) {
    const home = breadcrumbSegments(currentPath, homeDir);
    if (home[0]?.targetPath === homeDir) home[0] = { label: "~", targetPath: homeDir };
    return home;
  }
  const rootedAtFilesystem = rootDir === "/";
  const rootSeg: BreadcrumbSegment = { label: rootDisplayLabel(rootDir), targetPath: rootDir };

  if (currentPath === rootDir) return [rootSeg];

  let relativeParts: string[] = [];
  if (!rootedAtFilesystem && currentPath.startsWith(rootDir + "/")) {
    relativeParts = currentPath.slice(rootDir.length + 1).split("/").filter(Boolean);
  } else {
    relativeParts = currentPath.split("/").filter(Boolean);
  }

  const tailSegs: BreadcrumbSegment[] = relativeParts.map((label, idx) => {
    const prefix = rootedAtFilesystem ? "" : rootDir;
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
