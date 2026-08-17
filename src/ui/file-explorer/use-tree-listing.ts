import { useCallback, useMemo, useRef, useState, type MutableRefObject } from "react";
import { fsReadDir, type DirEntry } from "@/modules/fs/fs-bridge";
import { sshReadDir } from "@/modules/ssh/remote-fs-bridge";
import { joinPath, sortExplorerEntries, usableExplorerEntries, type SortDirection, type SortKey } from "./helpers";

export interface ExplorerTreeNode {
  entry: DirEntry;
  path: string;
  parentPath: string | null;
  level: number;
  posInSet: number;
  setSize: number;
}

export interface TreeLoadError {
  kind: "readFailed";
}

export interface TreeListingOptions {
  entries: DirEntry[];
  currentPath: string;
  sort: { key: SortKey; direction: SortDirection };
  includeHidden: boolean;
  isRemote: boolean;
  remotePtyId: number | undefined;
  remoteDisconnected: boolean;
  sessionId: string;
  transportGeneration?: string;
  treeRequestContext: string;
  treeRequestContextRef: MutableRefObject<string>;
}

export interface TreeListing {
  visibleTreeNodes: ExplorerTreeNode[];
  /** O(1) lookup of a node's index in visibleTreeNodes (roving focus, virtual scroll). */
  nodeIndexByPath: ReadonlyMap<string, number>;
  /** O(1) lookup of a node's direct children (null key = the root listing). */
  childrenByParent: ReadonlyMap<string | null, ExplorerTreeNode[]>;
  expandedPaths: Set<string>;
  treeErrors: Record<string, TreeLoadError>;
  expandDirectory: (path: string) => void;
  collapsePath: (path: string) => void;
  /** Invalidate in-flight child reads when the listing target changes. */
  beginListingEpoch: () => void;
  /** Drop expansion state after the root listing reloaded. */
  resetExpansion: () => void;
}

/**
 * Owns the expanded-directory tree state layered on top of the flat directory
 * listing: lazy child loading with per-path request tokens (so a stale read
 * can never populate a different directory/session), and the flattened
 * visible-node list used for rendering, focus roving, and virtualization.
 */
export function useTreeListing({
  entries,
  currentPath,
  sort,
  includeHidden,
  isRemote,
  remotePtyId,
  remoteDisconnected,
  sessionId,
  transportGeneration,
  treeRequestContext,
  treeRequestContextRef,
}: TreeListingOptions): TreeListing {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const [treeChildren, setTreeChildren] = useState<Record<string, DirEntry[]>>({});
  const [treeLoading, setTreeLoading] = useState<Set<string>>(() => new Set());
  const [treeErrors, setTreeErrors] = useState<Record<string, TreeLoadError>>({});
  const treeRequestGenerationRef = useRef(0);
  const treeRequestTokensRef = useRef(new Map<string, string>());

  const beginListingEpoch = useCallback(() => {
    treeRequestGenerationRef.current += 1;
    treeRequestTokensRef.current.clear();
    setTreeLoading(new Set());
    setTreeErrors({});
  }, []);

  const resetExpansion = useCallback(() => {
    setExpandedPaths(new Set());
    setTreeChildren({});
  }, []);

  const collapsePath = useCallback((path: string) => {
    setExpandedPaths((current) => {
      const next = new Set(current);
      next.delete(path);
      return next;
    });
  }, []);

  function expandDirectory(path: string) {
    setExpandedPaths((current) => new Set(current).add(path));
    if (treeChildren[path] || treeLoading.has(path) || remoteDisconnected) return;
    setTreeErrors((current) => {
      if (!(path in current)) return current;
      const next = { ...current };
      delete next[path];
      return next;
    });
    setTreeLoading((current) => new Set(current).add(path));
    const token = JSON.stringify({
      logical: sessionId,
      physical: remotePtyId ?? null,
      transport: transportGeneration ?? null,
      generation: treeRequestGenerationRef.current,
      path,
      includeHidden,
      remote: isRemote,
    });
    treeRequestTokensRef.current.set(path, token);
    const capturedContext = treeRequestContext;
    const currentRequest = () => treeRequestContextRef.current === capturedContext
      && treeRequestTokensRef.current.get(path) === token;
    const read = isRemote && remotePtyId !== undefined
      ? sshReadDir(remotePtyId, path, includeHidden)
      : fsReadDir(path, includeHidden);
    void read.then((children) => {
      if (!currentRequest()) return;
      setTreeChildren((current) => ({ ...current, [path]: children }));
      setTreeErrors((current) => {
        if (!(path in current)) return current;
        const next = { ...current };
        delete next[path];
        return next;
      });
    })
      .catch(() => {
        if (currentRequest()) {
          setTreeErrors((current) => ({ ...current, [path]: { kind: "readFailed" } }));
        }
      })
      .finally(() => setTreeLoading((current) => {
        if (!currentRequest()) return current;
        treeRequestTokensRef.current.delete(path);
        const next = new Set(current);
        next.delete(path);
        return next;
      }));
  }

  const visibleTreeNodes = useMemo(() => {
    const result: ExplorerTreeNode[] = [];
    const append = (siblings: DirEntry[], parent: string, parentLevel: number, parentPath: string | null) => {
      const usable = usableExplorerEntries(siblings);
      const sorted = [
        ...sortExplorerEntries(usable.filter((entry) => entry.kind === "dir"), sort.key, sort.direction),
        ...sortExplorerEntries(usable.filter((entry) => entry.kind !== "dir"), sort.key, sort.direction),
      ];
      sorted.forEach((entry, index) => {
        const path = joinPath(parent, entry.name);
        if (path === parent) return;
        result.push({ entry, path, parentPath, level: parentLevel, posInSet: index + 1, setSize: sorted.length });
        if (entry.kind === "dir" && expandedPaths.has(path) && treeChildren[path]) {
          append(treeChildren[path], path, parentLevel + 1, path);
        }
      });
    };
    append(entries, currentPath, 1, null);
    return result;
  }, [entries, currentPath, expandedPaths, treeChildren, sort]);

  // Row rendering used to run findIndex/filter per node (O(n²) on large
  // directories); one pass here keeps focus roving and child lookup O(1).
  const { nodeIndexByPath, childrenByParent } = useMemo(() => {
    const indexByPath = new Map<string, number>();
    const byParent = new Map<string | null, ExplorerTreeNode[]>();
    visibleTreeNodes.forEach((node, index) => {
      indexByPath.set(node.path, index);
      const siblings = byParent.get(node.parentPath);
      if (siblings) siblings.push(node);
      else byParent.set(node.parentPath, [node]);
    });
    return { nodeIndexByPath: indexByPath, childrenByParent: byParent };
  }, [visibleTreeNodes]);

  return {
    visibleTreeNodes,
    nodeIndexByPath,
    childrenByParent,
    expandedPaths,
    treeErrors,
    expandDirectory,
    collapsePath,
    beginListingEpoch,
    resetExpansion,
  };
}
