export const MAX_SPLIT_PANES = 4;
export const MIN_SPLIT_RATIO = 0.2;
export const MAX_SPLIT_RATIO = 0.8;
export const READER_SPLIT_RATIO = 0.4;
export const READER_PANE_PREFIX = "reader:";

export type SplitDirection = "horizontal" | "vertical";
export type SplitFocusDirection = "left" | "right" | "up" | "down";
export type SplitPath = string;

export type SplitLayoutNode =
  | { type: "pane"; sessionId: string }
  | { type: "reader"; sessionId: string }
  | {
      type: "split";
      direction: SplitDirection;
      ratio: number;
      first: SplitLayoutNode;
      second: SplitLayoutNode;
    };

export interface SplitState {
  root: SplitLayoutNode | null;
}

export interface SplitRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SplitPaneGeometry extends SplitRect {
  parentDirection: SplitDirection;
}

export interface SplitHandleGeometry {
  path: SplitPath;
  direction: SplitDirection;
  ratio: number;
  nodeRect: SplitRect;
}

export interface SplitLayoutGeometry {
  panes: Record<string, SplitPaneGeometry>;
  handles: SplitHandleGeometry[];
}

export function emptySplitState(): SplitState {
  return { root: null };
}

export function readerPaneId(sessionId: string): string {
  return `${READER_PANE_PREFIX}${sessionId}`;
}

export function isReaderPaneId(paneId: string): boolean {
  return paneId.startsWith(READER_PANE_PREFIX);
}

export function sessionIdFromPaneId(paneId: string): string {
  return isReaderPaneId(paneId) ? paneId.slice(READER_PANE_PREFIX.length) : paneId;
}

export function leafPaneId(node: Extract<SplitLayoutNode, { type: "pane" | "reader" }>): string {
  return node.type === "reader" ? readerPaneId(node.sessionId) : node.sessionId;
}

function clampRatio(ratio: number): number {
  return Math.max(MIN_SPLIT_RATIO, Math.min(MAX_SPLIT_RATIO, ratio));
}

function firstLeafId(node: SplitLayoutNode): string {
  if (node.type === "pane" || node.type === "reader") return leafPaneId(node);
  return firstLeafId(node.first);
}

function insertPaneNode(
  node: SplitLayoutNode,
  targetSessionId: string,
  newSessionId: string,
  direction: SplitDirection,
): SplitLayoutNode | null {
  if (node.type === "reader") return null;
  if (node.type === "pane") {
    if (node.sessionId !== targetSessionId) return null;
    return {
      type: "split",
      direction,
      ratio: 0.5,
      first: node,
      second: { type: "pane", sessionId: newSessionId },
    };
  }

  const first = insertPaneNode(node.first, targetSessionId, newSessionId, direction);
  if (first) return { ...node, first };
  const second = insertPaneNode(node.second, targetSessionId, newSessionId, direction);
  return second ? { ...node, second } : null;
}

function visitLeaves(node: SplitLayoutNode, visit: (leaf: Extract<SplitLayoutNode, { type: "pane" | "reader" }>) => void): void {
  if (node.type === "pane" || node.type === "reader") {
    visit(node);
    return;
  }
  visitLeaves(node.first, visit);
  visitLeaves(node.second, visit);
}

export function splitLayoutLeafIds(split: SplitState): string[] {
  if (!split.root) return [];
  const ids: string[] = [];
  visitLeaves(split.root, (leaf) => { ids.push(leafPaneId(leaf)); });
  return ids;
}

export function splitLayoutSessionIds(split: SplitState): string[] {
  if (!split.root) return [];
  const ids: string[] = [];
  visitLeaves(split.root, (leaf) => {
    if (leaf.type === "pane") ids.push(leaf.sessionId);
  });
  return ids;
}

export function splitLayoutHasSession(split: SplitState, sessionId: string): boolean {
  return splitLayoutSessionIds(split).includes(sessionId);
}

export function splitLayoutHasReader(split: SplitState, sessionId: string): boolean {
  return splitLayoutLeafIds(split).includes(readerPaneId(sessionId));
}

export function splitLayoutPaneCount(split: SplitState): number {
  return split.root ? splitLayoutLeafIds(split).length : 1;
}

export function canSplitLayout(split: SplitState): boolean {
  return splitLayoutPaneCount(split) < MAX_SPLIT_PANES;
}

export function insertSplitPane(
  split: SplitState,
  targetSessionId: string,
  newSessionId: string,
  direction: SplitDirection,
): SplitState | null {
  if (
    !targetSessionId
    || !newSessionId
    || targetSessionId === newSessionId
    || !canSplitLayout(split)
    || splitLayoutHasSession(split, newSessionId)
  ) return null;

  if (!split.root) {
    return {
      root: {
        type: "split",
        direction,
        ratio: 0.5,
        first: { type: "pane", sessionId: targetSessionId },
        second: { type: "pane", sessionId: newSessionId },
      },
    };
  }

  const root = insertPaneNode(split.root, targetSessionId, newSessionId, direction);
  return root ? { root } : null;
}

function insertReaderNode(node: SplitLayoutNode, sessionId: string): SplitLayoutNode | null {
  if (node.type === "reader") return null;
  if (node.type === "pane") {
    if (node.sessionId !== sessionId) return null;
    return {
      type: "split",
      direction: "horizontal",
      ratio: READER_SPLIT_RATIO,
      first: node,
      second: { type: "reader", sessionId },
    };
  }
  const first = insertReaderNode(node.first, sessionId);
  if (first) return { ...node, first };
  const second = insertReaderNode(node.second, sessionId);
  return second ? { ...node, second } : null;
}

export function insertReaderPane(split: SplitState, sessionId: string): SplitState | null {
  if (!sessionId || splitLayoutHasReader(split, sessionId) || !canSplitLayout(split)) return null;
  if (!split.root) {
    return {
      root: {
        type: "split",
        direction: "horizontal",
        ratio: READER_SPLIT_RATIO,
        first: { type: "pane", sessionId },
        second: { type: "reader", sessionId },
      },
    };
  }
  if (!splitLayoutHasSession(split, sessionId)) return null;
  const root = insertReaderNode(split.root, sessionId);
  return root ? { root } : null;
}

function replacePaneNode(
  node: SplitLayoutNode,
  targetSessionId: string,
  newSessionId: string,
): SplitLayoutNode {
  if (node.type === "reader") return node;
  if (node.type === "pane") {
    return node.sessionId === targetSessionId
      ? { type: "pane", sessionId: newSessionId }
      : node;
  }
  return {
    ...node,
    first: replacePaneNode(node.first, targetSessionId, newSessionId),
    second: replacePaneNode(node.second, targetSessionId, newSessionId),
  };
}

export function replaceSplitPane(
  split: SplitState,
  targetSessionId: string,
  newSessionId: string,
): SplitState {
  if (
    !split.root
    || targetSessionId === newSessionId
    || !splitLayoutHasSession(split, targetSessionId)
    || splitLayoutHasSession(split, newSessionId)
  ) return split;
  return { root: replacePaneNode(split.root, targetSessionId, newSessionId) };
}

interface RemoveNodeResult {
  node: SplitLayoutNode | null;
  removed: boolean;
  focusPaneId: string | null;
}

function leafMatches(node: Extract<SplitLayoutNode, { type: "pane" | "reader" }>, paneId: string): boolean {
  return leafPaneId(node) === paneId;
}

function removeLeafNode(node: SplitLayoutNode, paneId: string): RemoveNodeResult {
  if (node.type === "pane" || node.type === "reader") {
    return leafMatches(node, paneId)
      ? { node: null, removed: true, focusPaneId: null }
      : { node, removed: false, focusPaneId: null };
  }

  const firstResult = removeLeafNode(node.first, paneId);
  if (firstResult.removed) {
    if (!firstResult.node) {
      return { node: node.second, removed: true, focusPaneId: firstLeafId(node.second) };
    }
    return { node: { ...node, first: firstResult.node }, removed: true, focusPaneId: firstResult.focusPaneId };
  }

  const secondResult = removeLeafNode(node.second, paneId);
  if (!secondResult.removed) return { node, removed: false, focusPaneId: null };
  if (!secondResult.node) {
    return { node: node.first, removed: true, focusPaneId: firstLeafId(node.first) };
  }
  return { node: { ...node, second: secondResult.node }, removed: true, focusPaneId: secondResult.focusPaneId };
}

function collapseRemoved(result: RemoveNodeResult): { split: SplitState; removed: boolean; focusPaneId: string | null; focusSessionId: string | null } {
  if (!result.removed) {
    return { split: { root: result.node }, removed: false, focusPaneId: null, focusSessionId: null };
  }
  const root = result.node?.type === "split" ? result.node : null;
  const focusPaneId = result.focusPaneId;
  return {
    split: { root },
    removed: true,
    focusPaneId,
    focusSessionId: focusPaneId ? sessionIdFromPaneId(focusPaneId) : null,
  };
}

export function removeSplitPane(
  split: SplitState,
  sessionId: string,
): { split: SplitState; removed: boolean; focusSessionId: string | null } {
  const result = removeSplitLeavesForSession(split, sessionId);
  return { split: result.split, removed: result.removed, focusSessionId: result.focusSessionId };
}

export function removeReaderPane(
  split: SplitState,
  sessionId: string,
): { split: SplitState; removed: boolean; focusSessionId: string | null; focusPaneId: string | null } {
  if (!split.root) return { split, removed: false, focusSessionId: null, focusPaneId: null };
  return collapseRemoved(removeLeafNode(split.root, readerPaneId(sessionId)));
}

export function removeSplitLeavesForSession(
  split: SplitState,
  sessionId: string,
): { split: SplitState; removed: boolean; focusSessionId: string | null; focusPaneId: string | null } {
  if (!split.root) return { split, removed: false, focusSessionId: null, focusPaneId: null };
  let current = split.root;
  let removed = false;
  let focusPaneId: string | null = null;
  const readerResult = removeLeafNode(current, readerPaneId(sessionId));
  if (readerResult.removed) {
    removed = true;
    focusPaneId = readerResult.focusPaneId;
    if (!readerResult.node) {
      return { split: { root: null }, removed: true, focusSessionId: focusPaneId ? sessionIdFromPaneId(focusPaneId) : null, focusPaneId };
    }
    current = readerResult.node;
  }
  const paneResult = removeLeafNode(current, sessionId);
  if (paneResult.removed) {
    removed = true;
    focusPaneId = paneResult.focusPaneId ?? focusPaneId;
    current = paneResult.node as SplitLayoutNode;
    if (!paneResult.node) {
      return { split: { root: null }, removed: true, focusSessionId: focusPaneId ? sessionIdFromPaneId(focusPaneId) : null, focusPaneId };
    }
  }
  if (!removed) return { split, removed: false, focusSessionId: null, focusPaneId: null };
  return {
    split: { root: current.type === "split" ? current : null },
    removed: true,
    focusPaneId,
    focusSessionId: focusPaneId ? sessionIdFromPaneId(focusPaneId) : null,
  };
}

function setRatioAtNode(
  node: SplitLayoutNode,
  segments: string[],
  index: number,
  ratio: number,
): SplitLayoutNode {
  if (node.type !== "split") return node;
  if (index >= segments.length) return { ...node, ratio: clampRatio(ratio) };
  const segment = segments[index];
  if (segment === "first") {
    return { ...node, first: setRatioAtNode(node.first, segments, index + 1, ratio) };
  }
  if (segment === "second") {
    return { ...node, second: setRatioAtNode(node.second, segments, index + 1, ratio) };
  }
  return node;
}

export function setSplitRatioAt(split: SplitState, path: SplitPath, ratio: number): SplitState {
  if (!split.root || !Number.isFinite(ratio)) return split;
  const segments = path === "root" ? [] : path.split(".");
  const root = setRatioAtNode(split.root, segments, 0, ratio);
  return root === split.root ? split : { root };
}

export function splitLayoutGeometry(split: SplitState): SplitLayoutGeometry {
  const panes: Record<string, SplitPaneGeometry> = {};
  const handles: SplitHandleGeometry[] = [];
  const root = split.root;
  if (!root || root.type !== "split") return { panes, handles };

  const visit = (
    node: SplitLayoutNode,
    rect: SplitRect,
    path: SplitPath,
    parentDirection: SplitDirection,
  ) => {
    if (node.type === "pane" || node.type === "reader") {
      panes[leafPaneId(node)] = { ...rect, parentDirection };
      return;
    }

    handles.push({ path, direction: node.direction, ratio: node.ratio, nodeRect: rect });
    if (node.direction === "horizontal") {
      const firstWidth = rect.width * node.ratio;
      visit(node.first, { ...rect, width: firstWidth }, path === "root" ? "first" : `${path}.first`, node.direction);
      visit(node.second, {
        ...rect,
        x: rect.x + firstWidth,
        width: rect.width - firstWidth,
      }, path === "root" ? "second" : `${path}.second`, node.direction);
      return;
    }

    const firstHeight = rect.height * node.ratio;
    visit(node.first, { ...rect, height: firstHeight }, path === "root" ? "first" : `${path}.first`, node.direction);
    visit(node.second, {
      ...rect,
      y: rect.y + firstHeight,
      height: rect.height - firstHeight,
    }, path === "root" ? "second" : `${path}.second`, node.direction);
  };

  visit(root, { x: 0, y: 0, width: 1, height: 1 }, "root", root.direction);
  return { panes, handles };
}

function horizontalPaneCountNode(node: SplitLayoutNode): number {
  if (node.type === "pane" || node.type === "reader") return 1;
  const first = horizontalPaneCountNode(node.first);
  const second = horizontalPaneCountNode(node.second);
  return node.direction === "horizontal" ? first + second : Math.max(first, second);
}

export function splitHorizontalPaneCount(split: SplitState): number {
  return split.root ? horizontalPaneCountNode(split.root) : 1;
}

function perpendicularOverlap(a: SplitRect, b: SplitRect, direction: SplitFocusDirection): number {
  return direction === "left" || direction === "right"
    ? Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
    : Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
}

export function splitFocusTarget(
  split: SplitState,
  activePaneId: string | null,
  direction: SplitFocusDirection,
): string | null {
  if (!split.root || !activePaneId) return null;
  const panes = splitLayoutGeometry(split).panes;
  const active = panes[activePaneId];
  if (!active) return null;
  const epsilon = 1e-7;
  const candidates: Array<{ id: string; gap: number; overlap: number; centerDistance: number }> = [];

  for (const [id, pane] of Object.entries(panes)) {
    if (id === activePaneId) continue;
    let gap: number | null = null;
    if (direction === "left" && pane.x + pane.width <= active.x + epsilon) {
      gap = active.x - (pane.x + pane.width);
    } else if (direction === "right" && pane.x >= active.x + active.width - epsilon) {
      gap = pane.x - (active.x + active.width);
    } else if (direction === "up" && pane.y + pane.height <= active.y + epsilon) {
      gap = active.y - (pane.y + pane.height);
    } else if (direction === "down" && pane.y >= active.y + active.height - epsilon) {
      gap = pane.y - (active.y + active.height);
    }
    if (gap === null) continue;
    const overlap = perpendicularOverlap(active, pane, direction);
    if (overlap <= epsilon) continue;
    const centerDistance = direction === "left" || direction === "right"
      ? Math.abs((active.y + active.height / 2) - (pane.y + pane.height / 2))
      : Math.abs((active.x + active.width / 2) - (pane.x + pane.width / 2));
    candidates.push({ id, gap, overlap, centerDistance });
  }

  candidates.sort((a, b) =>
    a.gap - b.gap
    || b.overlap - a.overlap
    || a.centerDistance - b.centerDistance
    || a.id.localeCompare(b.id));
  return candidates[0]?.id ?? null;
}

function sanitizeNode(
  raw: unknown,
  validSessionIds: ReadonlySet<string>,
  seenTerminals: Set<string>,
  seenReaders: Set<string>,
  leafCount: { value: number },
  depth: number,
): SplitLayoutNode | null {
  if (!raw || typeof raw !== "object" || depth > 8) return null;
  const value = raw as Record<string, unknown>;
  if (value.type === "pane") {
    if (
      typeof value.sessionId !== "string"
      || !validSessionIds.has(value.sessionId)
      || seenTerminals.has(value.sessionId)
      || leafCount.value >= MAX_SPLIT_PANES
    ) return null;
    seenTerminals.add(value.sessionId);
    leafCount.value += 1;
    return { type: "pane", sessionId: value.sessionId };
  }
  if (value.type === "reader") {
    if (
      typeof value.sessionId !== "string"
      || !validSessionIds.has(value.sessionId)
      || seenReaders.has(value.sessionId)
      || leafCount.value >= MAX_SPLIT_PANES
    ) return null;
    seenReaders.add(value.sessionId);
    leafCount.value += 1;
    return { type: "reader", sessionId: value.sessionId };
  }
  if (value.type !== "split" || (value.direction !== "horizontal" && value.direction !== "vertical")) {
    return null;
  }

  const first = sanitizeNode(value.first, validSessionIds, seenTerminals, seenReaders, leafCount, depth + 1);
  const second = sanitizeNode(value.second, validSessionIds, seenTerminals, seenReaders, leafCount, depth + 1);
  if (!first) return second;
  if (!second) return first;
  const ratio = typeof value.ratio === "number" && Number.isFinite(value.ratio)
    ? clampRatio(value.ratio)
    : 0.5;
  return { type: "split", direction: value.direction, ratio, first, second };
}

export function sanitizeSplitLayout(
  raw: unknown,
  validSessionIds: ReadonlySet<string>,
): SplitState {
  const root = sanitizeNode(raw, validSessionIds, new Set<string>(), new Set<string>(), { value: 0 }, 0);
  return { root: root?.type === "split" ? root : null };
}
