import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { computeVirtualSlice } from "./lib/diff-virtual";

/** 未展开时的目录行距：30px 行 + 2px marginBottom。展开后子树高度不固定。 */
const LISTING_ROW_HEIGHT = 32;
/** 滚动容器上内边距 6px + 表头 24px + 表头下边距 3px。 */
const LISTING_TOP_INSET = 33;
const MAX_REMOTE_DOWNLOAD_BYTES = 100 * 1024 * 1024;
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { fsReadDir, type DirEntry } from "@/modules/fs/fs-bridge";
import {
  invalidateRemoteSearchCache,
  sshDownload,
  sshHome,
  sshReadDir,
} from "@/modules/ssh/remote-fs-bridge";
import { formatSize } from "./types";
import { PanelEmptyState, PanelLoadingState } from "./shared";
import { ContextMenu, type MenuEntry } from "./ContextMenu";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { openResource, resourceRefForSession } from "@/modules/resources/resource-ref";
import { openInEditorWithToast } from "./lib/open-in-editor";
import { useT, t as staticT } from "@/modules/i18n";
import { ExplorerNav, ExplorerRemoteTools, ExplorerSearchRow } from "./file-explorer/chrome";
import { copyText } from "./lib/clipboard";
import { knownRemoteExplorerRoot, remoteExplorerListingRoot, remoteExplorerSearchRoot } from "./lib/file-explorer-root";
import { openRemoteInExternalEditor } from "@/modules/ssh/remote-external-edit";
import { dropDestinationFromListing } from "@/modules/ssh/drop-target";
import {
  emptyHostFilePrefs,
  hostFilePrefsKey,
  pushHostRecentPath,
  rememberHostDownloadDir,
  toggleHostFavoritePath,
} from "@/modules/ssh/host-file-prefs";
import {
  expandFolderTransfer,
  planBatchDownloads,
  resolveDownloadLimits,
  type BatchDownloadSource,
} from "@/modules/ssh/transfer-intent";
import { validateManifest } from "@/modules/ssh/transfer-bridge";
import { useTransferStore } from "@/modules/ssh/transfer-store";
import type { SessionBindingV1 } from "@/modules/terminal/lib/pty-bridge";
import { RemoteFsMutationDialog } from "@/modules/ssh/remote-fs/RemoteFsMutationDialog";
import { RemoteMetadataPanel } from "@/modules/ssh/remote-fs/RemoteMetadataPanel";
import { sshStatV1, type MutationRequestV1, type PathExpectationV1 } from "@/modules/ssh/remote-fs/bridge";
import { Modal, useModalBehavior } from "./overlays/Modal";
import { FileIcon, FolderIcon, folderEmptyIcon, TreeChevron } from "./file-explorer/icons";
import {
  compactRelativePath,
  formatModifiedTime,
  joinPath,
  nextOperationId,
  parentPath,
  type SortDirection,
  type SortKey,
} from "./file-explorer/helpers";
import { downloadFailureKey } from "./file-explorer/transfer-failures";
import { queueLocalTransferPaths } from "./file-explorer/upload-preflight";
import { useExplorerSearch } from "./file-explorer/use-explorer-search";
import { useTreeListing, type ExplorerTreeNode } from "./file-explorer/use-tree-listing";
import { useDirectUpload } from "./file-explorer/use-direct-upload";
import { SearchLimitControl, SearchRetryButton } from "./file-explorer/search-controls";

// Re-exported for existing importers/tests; implementations moved to ./file-explorer/.
export { downloadFailureKey, parseUploadFailure, uploadFailureKey, type UploadFailure } from "./file-explorer/transfer-failures";
export { sortExplorerEntries, formatModifiedTime } from "./file-explorer/helpers";

interface FileExplorerProps {
  sessionId: string;
  rootDir: string;
  /**
   * 远程 SSH 会话的 PTY id。存在则文件操作走 SFTP；否则走本地 fs。
   * SSH 浏览根始终是远端 `/`。rootDir 有 OSC 7 绝对路径时从该 cwd 打开；
   * 旧会话标签才回退到 SFTP home。home / cwd 只是起点，不是树根。
   */
  remotePtyId?: number;
  /** Backend-authored generation required by transfer/mutation v1 contracts. */
  transportGeneration?: string;
  /** Stable transport identity while the physical SSH PTY is unavailable. */
  remote?: boolean;
  remoteHost?: string;
}

interface DownloadTransfer {
  disposed: boolean;
}

export function FileExplorer({
  sessionId,
  rootDir,
  remotePtyId,
  transportGeneration,
  remote = remotePtyId !== undefined,
  remoteHost,
}: FileExplorerProps) {
  const t = useT();
  const isRemote = remote;
  const remoteDisconnected = isRemote && remotePtyId === undefined;
  const remoteInfo = useSessionsStore((state) => state.sessions.find((session) => session.id === sessionId)?.remote);
  const prefsKey = remoteInfo ? hostFilePrefsKey(remoteInfo) : null;
  const storedPrefs = useSessionsStore((state) => (prefsKey ? state.hostFilePrefs[prefsKey] : undefined));
  const hostPrefs = storedPrefs ?? emptyHostFilePrefs();
  const followTerminalCwd = isRemote && hostPrefs.followTerminalCwd;
  const directUpload = useDirectUpload({ sessionId, remotePtyId, t, onUploaded: () => refresh() });
  const { upload, transferAnnouncement } = directUpload;
  const [download, setDownload] = useState<{ fileName: string } | null>(null);
  const downloadTransferRef = useRef<DownloadTransfer | null>(null);
  const [selectedDownloads, setSelectedDownloads] = useState<Map<string, BatchDownloadSource>>(() => new Map());
  const [batchDownloadPreparing, setBatchDownloadPreparing] = useState(false);
  const selectionAnchorRef = useRef<string | null>(null);
  const copyPathWithFeedback = async (path: string) => {
    const ok = await copyText(path);
    useUIStore.getState().addToast({
      sessionId,
      title: t(ok ? "clipboard.copy_success" : "clipboard.copy_failed"),
      subtitle: "",
      variant: ok ? "success" : "error",
    });
  };

  const downloadRemoteFile = async (remotePath: string, fileName: string) => {
    if (remotePtyId === undefined || downloadTransferRef.current) return;
    const transfer: DownloadTransfer = { disposed: false };
    downloadTransferRef.current = transfer;
    try {
      const localPath = await saveDialog({
        title: t("explorer.download.choose_destination"),
        defaultPath: fileName,
      });
      if (!localPath || transfer.disposed) return;
      setDownload({ fileName });
      const bytes = await sshDownload(remotePtyId, remotePath, localPath);
      if (transfer.disposed) return;
      useUIStore.getState().addToast({
        sessionId,
        title: t("explorer.download.complete"),
        subtitle: `${fileName} · ${formatSize(bytes)}`,
        variant: "success",
      });
    } catch (error) {
      if (!transfer.disposed) {
        useUIStore.getState().addToast({
          sessionId,
          title: t("explorer.download.failed"),
          subtitle: t(downloadFailureKey(error)),
          variant: "error",
        });
      }
    } finally {
      if (downloadTransferRef.current === transfer) downloadTransferRef.current = null;
      if (!transfer.disposed) setDownload(null);
    }
  };

  const downloadRemoteFolder = async (remotePath: string, folderName: string) => {
    if (!binding) return;
    try {
      const selected = await openDialog({
        title: t("explorer.download.batch_choose_destination"),
        directory: true,
        multiple: false,
      });
      const destinationParent = Array.isArray(selected) ? selected[0] : selected;
      if (!destinationParent) return;
      const manifest = await validateManifest(
        { kind: "remote", root: remotePath, binding },
        { maxEntries: downloadLimits.maxFiles, maxTotalBytes: downloadLimits.maxTotalBytes },
      );
      const plan = expandFolderTransfer({
        manifest,
        binding,
        direction: "download",
        sourceRoot: remotePath,
        destinationRoot: joinPath(destinationParent, folderName),
        conflict: "rename",
      });
      useTransferStore.getState().enqueueBatch(plan.requests);
      useUIStore.getState().addToast({
        sessionId,
        title: t("explorer.download.batch_queued"),
        subtitle: t("explorer.download.batch_queued_hint", { count: plan.requests.length }),
        variant: "success",
      });
    } catch (error) {
      useUIStore.getState().addToast({
        sessionId,
        title: t("explorer.download.failed"),
        subtitle: error instanceof Error ? error.message : t("explorer.download.batch_prepare_failed"),
        variant: "error",
      });
    }
  };
  // Local sessions stay scoped to the workspace directory. Remote sessions
  // browse the whole host from `/`; home and OSC 7 cwd are starting locations.
  const [baseDir, setBaseDir] = useState<string | null>(isRemote ? null : rootDir);
  const [homeDir, setHomeDir] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState(isRemote ? "" : rootDir);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [navDir, setNavDir] = useState<"in" | "out" | null>(null);
  const [includeHidden, setIncludeHidden] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({ key: "name", direction: "asc" });
  const searchRoot = isRemote ? remoteExplorerSearchRoot(currentPath, homeDir) : baseDir;
  const search = useExplorerSearch({ baseDir: searchRoot, includeHidden, reloadKey, isRemote, remotePtyId, remoteDisconnected });
  const {
    searchQuery,
    searchMode,
    searchHits,
    grepHits,
    searchLoading,
    searchError,
    searchTruncated,
    grepTruncated,
    searchLimit,
    searchMaxLimit,
    isSearching,
  } = search;
  const [contextMenu, setContextMenu] = useState<{
    items: MenuEntry[];
    position: { x: number; y: number };
    bindingKey: string;
  } | null>(null);
  const externalEditor = useUIStore((s) => s.externalEditor);
  const downloadMaxFiles = useUIStore((s) => s.downloadMaxFiles);
  const downloadMaxFileBytes = useUIStore((s) => s.downloadMaxFileBytes);
  const downloadMaxTotalBytes = useUIStore((s) => s.downloadMaxTotalBytes);
  const downloadLimits = useMemo(
    () => resolveDownloadLimits({
      maxFiles: downloadMaxFiles,
      maxFileBytes: downloadMaxFileBytes,
      maxTotalBytes: downloadMaxTotalBytes,
    }),
    [downloadMaxFiles, downloadMaxFileBytes, downloadMaxTotalBytes],
  );
  const activeFilePath = useUIStore((s) =>
    s.fileTabs.find((tab) => tab.id === s.activeFileTabId && tab.sessionId === sessionId)?.filePath,
  );
  const resultsListRef = useRef<HTMLDivElement>(null);
  // 目录列表虚拟滚动：行距恒定 32px（30 按钮 + 2 margin），仅列表很长时启用
  const [listScroll, setListScroll] = useState({ top: 0, height: 0 });
  const [pendingListingFocus, setPendingListingFocus] = useState<number | null>(null);
  const [listingFocusIndex, setListingFocusIndex] = useState(0);
  const explorerRef = useRef<HTMLDivElement>(null);
  const listingDropRef = useRef<{ currentPath: string; nodes: ExplorerTreeNode[] }>({ currentPath: "", nodes: [] });
  const [dropActive, setDropActive] = useState(false);
  const [dropHighlightPath, setDropHighlightPath] = useState<string | null>(null);
  const [dropMessage, setDropMessage] = useState("");
  const [mutationComposer, setMutationComposer] = useState<{ kind: "mkdir" | "rename"; node: ExplorerTreeNode; value: string; bindingKey: string } | null>(null);
  const [propertiesPath, setPropertiesPath] = useState<string | null>(null);
  const [mutationRequest, setMutationRequest] = useState<MutationRequestV1 | null>(null);
  const [mutationBusy, setMutationBusy] = useState(false);
  const treeRequestContext = JSON.stringify({
    logical: sessionId,
    physical: remotePtyId ?? null,
    transport: transportGeneration ?? null,
    currentPath,
    includeHidden,
    remote: isRemote,
    disconnected: remoteDisconnected,
  });
  const treeRequestContextRef = useRef(treeRequestContext);
  // Render-time assignment closes the window before passive effect cleanup.
  treeRequestContextRef.current = treeRequestContext;
  const {
    visibleTreeNodes,
    nodeIndexByPath,
    childrenByParent,
    expandedPaths,
    treeErrors,
    expandDirectory,
    collapsePath,
    beginListingEpoch,
    resetExpansion,
  } = useTreeListing({
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
  });
  useEffect(() => {
    setSelectedDownloads(new Map());
    selectionAnchorRef.current = null;
    setBatchDownloadPreparing(false);
  }, [treeRequestContext]);
  const mutationComposerRef = useRef<HTMLDivElement>(null);
  const menuReturnFocusRef = useRef<HTMLElement>(null);
  useModalBehavior(mutationComposerRef, {
    active: mutationComposer !== null,
    initialFocus: "input",
    bindingKey: mutationComposer?.bindingKey,
    currentBindingKey: treeRequestContext,
    returnFocusToken: menuReturnFocusRef,
    onRequestClose: (reason) => {
      if (mutationBusy && reason !== "stale-binding") return;
      setMutationComposer(null);
      restoreMenuFocus();
    },
  });
  const focusedPathRef = useRef<string | null>(null);
  const menuReturnPathRef = useRef<string | null>(null);
  const suppressMenuFocusRef = useRef(false);
  const typeaheadRef = useRef({ text: "", timer: 0 });
  const binding = useMemo<SessionBindingV1 | null>(() => isRemote
    && remotePtyId !== undefined
    && transportGeneration
    ? { logicalSessionId: sessionId, physicalPtyId: remotePtyId, transportGeneration }
    : null, [isRemote, remotePtyId, sessionId, transportGeneration]);
  const activeTransferNotice = useTransferStore((s) =>
    s.items.filter((item) => item.binding.logicalSessionId === sessionId && (item.status === "queued" || item.status === "running")).length
    + s.recoveries.filter((item) => item.record.session === sessionId).length,
  );
  const mutationRequestIsCurrent = !mutationRequest || !!binding
    && mutationRequest.binding.logicalSessionId === binding.logicalSessionId
    && mutationRequest.binding.physicalPtyId === binding.physicalPtyId
    && mutationRequest.binding.transportGeneration === binding.transportGeneration;
  useEffect(() => {
    if (mutationRequest && !mutationRequestIsCurrent) setMutationRequest(null);
  }, [mutationRequest, mutationRequestIsCurrent]);

  const queueLocalPaths = useCallback(async (paths: string[], destinationRoot: string) => {
    if (!binding || paths.length === 0) return false;
    const result = await queueLocalTransferPaths({ binding, remoteHost, paths, destinationRoot, t });
    if (result.status === "prepareFailed") {
      setDropMessage(t("explorer.mutation.prepare_failed"));
      return false;
    }
    setDropMessage(t("explorer.drop.queued", { files: result.files, directories: result.directories }));
    return true;
  }, [binding, remoteHost, t]);

  useEffect(() => () => {
    const downloadTransfer = downloadTransferRef.current;
    if (downloadTransfer) {
      downloadTransfer.disposed = true;
      if (downloadTransferRef.current === downloadTransfer) downloadTransferRef.current = null;
      setDownload(null);
    }
  }, [remotePtyId, sessionId]);

  useEffect(() => {
    if (!binding) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const handleDragDrop = (event: Parameters<Parameters<ReturnType<typeof getCurrentWebview>["onDragDropEvent"]>[0]>[0]) => {
      if (disposed) return;
      if (event.payload.type === "leave") {
        setDropActive(false);
        setDropHighlightPath(null);
        return;
      }
      const rect = explorerRef.current?.getBoundingClientRect();
      const listRect = resultsListRef.current?.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      const x = event.payload.position.x / scale;
      const y = event.payload.position.y / scale;
      const inside = rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      if (!inside) return;
      const listing = listingDropRef.current;
      const destination = listRect
        ? dropDestinationFromListing({
          clientY: y,
          listTop: listRect.top,
          scrollTop: resultsListRef.current?.scrollTop ?? 0,
          inset: LISTING_TOP_INSET,
          rowHeight: LISTING_ROW_HEIGHT,
          nodes: listing.nodes.map((node) => ({
            path: node.path,
            parentPath: node.parentPath,
            kind: node.entry.kind,
          })),
          currentPath: listing.currentPath,
        })
        : { path: listing.currentPath, highlightPath: null };
      if (event.payload.type === "enter" || event.payload.type === "over") {
        setDropActive(true);
        setDropHighlightPath(destination.highlightPath);
      } else if (event.payload.type === "drop") {
        setDropActive(false);
        setDropHighlightPath(null);
        void queueLocalPaths(event.payload.paths, destination.path).catch((error: unknown) => {
          setDropMessage(t("explorer.drop.failed"));
          useUIStore.getState().addToast({
            sessionId,
            title: t("explorer.drop.failed"),
            subtitle: error instanceof Error ? error.message : String(error),
            variant: "error",
          });
        });
      }
    };
    try {
      void getCurrentWebview().onDragDropEvent(handleDragDrop)
        .then((next) => { if (disposed) next(); else unlisten = next; })
        .catch(() => {});
    } catch {
      // Browser/unit-test environments have no current Tauri webview.
    }
    return () => { disposed = true; unlisten?.(); };
  }, [binding, queueLocalPaths, sessionId, t]);

  const uploadToRemoteDirectory = async (directory: string) => {
    if (remotePtyId === undefined || directUpload.isUploadActive()) return;
    if (binding) {
      let selected: string | string[] | null;
      try {
        selected = await openDialog({
          title: t("explorer.upload.choose_file"),
          directory: false,
          multiple: true,
        });
      } catch {
        useUIStore.getState().addToast({ sessionId, title: t("explorer.upload.failed"), subtitle: t("explorer.upload.failed_hint"), variant: "error" });
        return;
      }
      const paths = selected === null ? [] : Array.isArray(selected) ? selected : [selected];
      try {
        await queueLocalPaths(paths, directory);
      } catch {
        useUIStore.getState().addToast({ sessionId, title: t("explorer.drop.failed"), subtitle: t("explorer.mutation.prepare_failed"), variant: "error" });
      }
      return;
    }
    await directUpload.uploadFilesDirect(directory);
  };

  const uploadFolderToRemoteDirectory = async (directory: string) => {
    if (!binding) return;
    const selected = await openDialog({
      title: t("explorer.upload.choose_folder"),
      directory: true,
      multiple: false,
    });
    const path = Array.isArray(selected) ? selected[0] : selected;
    if (path) {
      try {
        await queueLocalPaths([path], directory);
      } catch {
        useUIStore.getState().addToast({ sessionId, title: t("explorer.drop.failed"), subtitle: t("explorer.mutation.prepare_failed"), variant: "error" });
      }
    }
  };

  const openEditor = (path: string, line?: number) => {
    void openInEditorWithToast(externalEditor, path, { line });
  };

  // Resolve the starting directory. Local: workspace rootDir. Remote: `/`
  // is the listing root; OSC 7 or SFTP home is only the first location.
  useEffect(() => {
    setNavDir(null);
    search.resetSearch();
    if (isRemote) {
      if (remotePtyId === undefined) return;
      const listingRoot = remoteExplorerListingRoot();
      setHomeDir(null);
      setBaseDir(listingRoot);
      const knownStart = knownRemoteExplorerRoot(rootDir);
      if (knownStart) setCurrentPath((current) => current || knownStart);
      else setLoading(true);
      let cancelled = false;
      sshHome(remotePtyId)
        .then((home) => {
          if (!cancelled) {
            setHomeDir(home);
            setCurrentPath((current) => current || home);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setHomeDir(null);
            setCurrentPath((current) => current || listingRoot);
            if (!knownStart) {
              useUIStore.getState().addToast({
                sessionId,
                title: staticT("explorer.remote_home_failed"),
                subtitle: "",
                variant: "warning",
              });
            }
          }
        });
      return () => { cancelled = true; };
    }
    setHomeDir(null);
    setBaseDir(rootDir);
    setCurrentPath(rootDir);
    // Follow-cwd applies later OSC 7 updates. Including rootDir here would
    // clear search and reset local/remote explorers on every shell cd.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [isRemote, remotePtyId, sessionId]);

  useEffect(() => {
    if (!isRemote || !followTerminalCwd) return;
    const knownStart = knownRemoteExplorerRoot(rootDir);
    if (!knownStart) return;
    setCurrentPath(knownStart);
  }, [rootDir, isRemote, followTerminalCwd]);

  useEffect(() => {
    if (!prefsKey || !currentPath.startsWith("/")) return;
    useSessionsStore.getState().patchHostFilePrefs(prefsKey, (prefs) => pushHostRecentPath(prefs, currentPath));
  }, [prefsKey, currentPath]);

  useEffect(() => {
    beginListingEpoch();
    if (baseDir === null || !currentPath.startsWith("/")) return;
    if (remoteDisconnected) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(false);
    const read =
      isRemote && remotePtyId !== undefined
        ? sshReadDir(remotePtyId, currentPath, includeHidden)
        : fsReadDir(currentPath, includeHidden);
    read
      .then((e) => {
        if (!cancelled) {
          setEntries(e);
          resetExpansion();
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setEntries([]);
          setError(true);
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [currentPath, includeHidden, reloadKey, baseDir, isRemote, remotePtyId, remoteDisconnected, sessionId, transportGeneration, beginListingEpoch, resetExpansion]);

  const canGoUp = currentPath !== "/" && (isRemote || currentPath !== baseDir);
  const breadcrumbRoot = isRemote
    ? remoteExplorerListingRoot()
    : baseDir !== null
      && (currentPath === baseDir || currentPath.startsWith(`${baseDir}/`))
      ? baseDir
      : "/";
  listingDropRef.current = { currentPath, nodes: visibleTreeNodes };
  const selectableDownloadNodes = useMemo(() => binding
    ? visibleTreeNodes.filter((node) => node.entry.kind === "file" && node.entry.size <= downloadLimits.maxFileBytes)
    : [], [binding, visibleTreeNodes, downloadLimits]);

  // ── 目录列表虚拟滚动（仅非搜索态的大目录启用；搜索结果本身有 searchLimit 分页）──
  const contentKey = isSearching ? `search:${searchQuery}` : currentPath;
  useLayoutEffect(() => {
    const el = resultsListRef.current;
    if (!el) return;
    const update = () => setListScroll({ top: el.scrollTop, height: el.clientHeight });
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [contentKey]);
  const listingRowCount = visibleTreeNodes.length;
  // Nested groups have variable height, so only virtualize the unexpanded root
  // list. Once a directory is expanded, render the semantic hierarchy in full.
  const virtualizeListing = !isSearching && expandedPaths.size === 0 && listingRowCount > 100;
  const listingSlice = virtualizeListing
    ? computeVirtualSlice(
        listingRowCount,
        Math.max(0, listScroll.top - LISTING_TOP_INSET),
        listScroll.height,
        LISTING_ROW_HEIGHT,
      )
    : { first: 0, last: listingRowCount, topPad: 0, bottomPad: 0 };
  useEffect(() => {
    setListingFocusIndex((current) => Math.max(0, Math.min(current, listingRowCount - 1)));
  }, [listingRowCount]);

  useEffect(() => {
    setListingFocusIndex(0);
  }, [contentKey]);

  useEffect(() => {
    const path = focusedPathRef.current;
    if (!path || isSearching) return;
    const index = nodeIndexByPath.get(path) ?? -1;
    if (index >= 0) setListingFocusIndex(index);
  }, [nodeIndexByPath, isSearching]);

  useEffect(() => {
    if (pendingListingFocus === null) return;
    const target = resultsListRef.current?.querySelector<HTMLElement>(
      `[data-listing-index="${pendingListingFocus}"]`,
    );
    if (!target) {
      setPendingListingFocus(null);
      return;
    }
    target.focus({ preventScroll: true });
    setPendingListingFocus(null);
  }, [pendingListingFocus, listingSlice.first, listingSlice.last]);

  function refresh() {
    if (remoteDisconnected) return;
    // Drop the remote search cache so Refresh actually re-runs ssh_fs_search
    // instead of returning the cached (now-stale) hits while the directory
    // listing reloads — otherwise Refresh is a no-op for remote search.
    if (isRemote && remotePtyId !== undefined) {
      invalidateRemoteSearchCache(remotePtyId);
    }
    setReloadKey((n) => n + 1);
  }

  function goUp() {
    setNavDir("out");
    setCurrentPath(parentPath(currentPath));
  }

  function focusTreeIndex(index: number) {
    const target = Math.max(0, Math.min(index, visibleTreeNodes.length - 1));
    const node = visibleTreeNodes[target];
    if (!node) return;
    focusedPathRef.current = node.path;
    setListingFocusIndex(target);
    const list = resultsListRef.current;
    const mounted = list?.querySelector<HTMLElement>(`[data-listing-index="${target}"]`);
    if (mounted) mounted.focus();
    else if (list) {
      const rowTop = LISTING_TOP_INSET + target * LISTING_ROW_HEIGHT;
      list.scrollTop = Math.max(0, rowTop - Math.max(0, list.clientHeight - LISTING_ROW_HEIGHT));
      setListScroll({ top: list.scrollTop, height: list.clientHeight });
      setPendingListingFocus(target);
    }
  }

  function restoreMenuFocus() {
    const path = menuReturnPathRef.current;
    window.setTimeout(() => {
      const focused = document.activeElement;
      const canRestore = !focused
        || focused === document.body
        || focused === document.documentElement
        || !focused.isConnected;
      if (!canRestore) return;
      const returnFocus = menuReturnFocusRef.current;
      if (returnFocus?.isConnected) {
        returnFocus.focus({ preventScroll: true });
        return;
      }
      const index = path === null ? -1 : nodeIndexByPath.get(path) ?? -1;
      if (index >= 0) focusTreeIndex(index);
    });
  }

  async function observedExpectation(path: string): Promise<PathExpectationV1> {
    if (!binding) throw new Error("remote session binding unavailable");
    try {
      const metadata = await sshStatV1(binding, path);
      return { state: "present", identity: metadata.precondition };
    } catch (error) {
      if (String(error).includes("SSH_REMOTE_FS_NOT_FOUND")) return { state: "absent" };
      throw error;
    }
  }

  async function prepareDelete(node: ExplorerTreeNode) {
    if (!binding || mutationBusy) return;
    const requestContext = treeRequestContextRef.current;
    setMutationBusy(true);
    try {
      const metadata = await sshStatV1(binding, node.path);
      if (treeRequestContextRef.current !== requestContext) return;
      if (!metadata.parentPrecondition) throw new Error("parent metadata unavailable");
      setMutationRequest({
        operationId: nextOperationId(),
        binding,
        operation: { kind: "delete", path: node.path },
        precondition: {
          source: { state: "present", identity: metadata.precondition },
          sourceParent: metadata.parentPrecondition,
        },
      });
    } catch (error) {
      if (treeRequestContextRef.current !== requestContext) return;
      useUIStore.getState().addToast({ sessionId, title: t("explorer.mutation.prepare_failed"), subtitle: String(error), variant: "error" });
    } finally {
      setMutationBusy(false);
    }
  }

  async function prepareNamedMutation() {
    if (!binding || !mutationComposer || mutationBusy) return;
    const requestContext = mutationComposer.bindingKey;
    const name = mutationComposer.value.trim();
    if (!name || name === "." || name === ".." || /[\\/\r\n]/.test(name)) return;
    setMutationBusy(true);
    try {
      if (mutationComposer.kind === "mkdir") {
        const parentMetadata = await sshStatV1(binding, mutationComposer.node.path);
        if (treeRequestContextRef.current !== requestContext) return;
        const path = joinPath(mutationComposer.node.path, name);
        const source = await observedExpectation(path);
        if (treeRequestContextRef.current !== requestContext) return;
        setMutationRequest({
          operationId: nextOperationId(),
          binding,
          operation: { kind: "mkdir", path },
          precondition: {
            source,
            sourceParent: parentMetadata.precondition,
          },
        });
      } else {
        const source = await sshStatV1(binding, mutationComposer.node.path);
        if (treeRequestContextRef.current !== requestContext) return;
        if (!source.parentPrecondition) throw new Error("parent metadata unavailable");
        const destinationPath = joinPath(mutationComposer.node.parentPath ?? currentPath, name);
        const destination = await observedExpectation(destinationPath);
        if (treeRequestContextRef.current !== requestContext) return;
        setMutationRequest({
          operationId: nextOperationId(),
          binding,
          operation: { kind: "rename", sourcePath: mutationComposer.node.path, destinationPath, replace: false },
          precondition: {
            source: { state: "present", identity: source.precondition },
            sourceParent: source.parentPrecondition,
            destination,
            destinationParent: source.parentPrecondition,
          },
        });
      }
      setMutationComposer(null);
    } catch (error) {
      if (treeRequestContextRef.current !== requestContext) return;
      useUIStore.getState().addToast({ sessionId, title: t("explorer.mutation.prepare_failed"), subtitle: String(error), variant: "error" });
    } finally {
      setMutationBusy(false);
    }
  }

  function treeMenuItems(node: ExplorerTreeNode): MenuEntry[] {
    const isDir = node.entry.kind === "dir";
    if (isDir) {
      return isRemote
        ? [
            { id: "dir:mkdir", label: t("explorer.mutation.mkdir"), icon: "folder", action: () => { suppressMenuFocusRef.current = true; setMutationComposer({ kind: "mkdir", node, value: "", bindingKey: treeRequestContext }); } },
            { id: "dir:new-file", label: t("explorer.capability.new_file_unavailable"), icon: "editor", disabled: true, action: () => {} },
            { id: "dir:download", label: t("explorer.download_folder"), icon: "download", disabled: remoteDisconnected || !binding, action: () => { void downloadRemoteFolder(node.path, node.entry.name); } },
            { id: "dir:rename", label: t("explorer.mutation.rename"), icon: "rename", action: () => { suppressMenuFocusRef.current = true; setMutationComposer({ kind: "rename", node, value: node.entry.name, bindingKey: treeRequestContext }); } },
            { id: "dir:delete", label: t("explorer.mutation.delete"), icon: "close", danger: true, action: () => { suppressMenuFocusRef.current = true; void prepareDelete(node); } },
            { id: "dir:metadata", label: t("explorer.properties"), icon: "search", action: () => { suppressMenuFocusRef.current = true; setPropertiesPath(node.path); } },
            { id: "dir:copy-path", label: t("sidebar.dir.copy_path"), icon: "copy", action: () => { void copyPathWithFeedback(node.path); } },
          ]
        : [
            { id: "dir:new-terminal", label: t("sidebar.dir.new_terminal"), icon: "terminal", action: () => useSessionsStore.getState().newTerminalInDir(node.path) },
            { id: "dir:open-editor", label: t("sidebar.dir.open_in_editor"), icon: "editor", action: () => openEditor(node.path) },
            { id: "dir:copy-path", label: t("sidebar.dir.copy_path"), icon: "copy", action: () => { void copyPathWithFeedback(node.path); } },
          ];
    }
    return isRemote
      ? [
          { id: "file:open-tunara", label: t("explorer.open_in_tunara"), icon: "editor", action: () => openFile(node.path) },
          { id: "file:open-editor", label: t("preview.editor.external_remote"), icon: "editor", disabled: remoteDisconnected || remotePtyId === undefined, action: () => { if (remotePtyId !== undefined) void openRemoteInExternalEditor({ sessionId, remotePtyId, remotePath: node.path, editor: externalEditor }).catch(() => {}); } },
          { id: "file:rename", label: t("explorer.mutation.rename"), icon: "rename", action: () => { suppressMenuFocusRef.current = true; setMutationComposer({ kind: "rename", node, value: node.entry.name, bindingKey: treeRequestContext }); } },
          { id: "file:delete", label: t("explorer.mutation.delete"), icon: "close", danger: true, action: () => { suppressMenuFocusRef.current = true; void prepareDelete(node); } },
          { id: "file:metadata", label: t("explorer.properties"), icon: "search", action: () => { suppressMenuFocusRef.current = true; setPropertiesPath(node.path); } },
          { id: "file:open-terminal", label: t("explorer.open_in_terminal"), icon: "terminal", action: () => useSessionsStore.getState().openFileInTerminal(sessionId, node.parentPath ?? currentPath, node.entry.name) },
          { id: "file:download", label: node.entry.size > MAX_REMOTE_DOWNLOAD_BYTES ? t("explorer.download.too_large") : t("explorer.download"), icon: "download", disabled: node.entry.size > MAX_REMOTE_DOWNLOAD_BYTES || download !== null, action: () => { void downloadRemoteFile(node.path, node.entry.name); } },
          { id: "file:copy-path", label: t("sidebar.dir.copy_path"), icon: "copy", action: () => { void copyPathWithFeedback(node.path); } },
        ]
      : [
          { id: "file:open-tunara", label: t("explorer.open_in_tunara"), icon: "editor", action: () => openFile(node.path) },
          { id: "file:open-terminal", label: t("explorer.open_in_terminal"), icon: "terminal", action: () => useSessionsStore.getState().openFileInTerminal(sessionId, node.parentPath ?? currentPath, node.entry.name) },
          { id: "file:open-vscode", label: t("explorer.open_in_vscode"), icon: "editor", action: () => { void openInEditorWithToast("vscode", node.path, { sessionId }); } },
          ...(externalEditor === "vscode" ? [] : [{ id: "file:open-editor", label: t("sidebar.dir.open_in_editor"), icon: "editor" as const, action: () => openEditor(node.path) }]),
          { id: "file:copy-path", label: t("sidebar.dir.copy_path"), icon: "copy", action: () => { void copyPathWithFeedback(node.path); } },
        ];
  }

  function toggleDownloadSelection(node: ExplorerTreeNode, range: boolean) {
    if (!binding || node.entry.kind !== "file" || node.entry.size > downloadLimits.maxFileBytes) return;
    const nextSource = { path: node.path, name: node.entry.name, size: node.entry.size };
    setSelectedDownloads((current) => {
      const next = new Map(current);
      let totalBytes = [...next.values()].reduce((total, source) => total + source.size, 0);
      if (range && selectionAnchorRef.current) {
        const anchor = selectableDownloadNodes.findIndex(({ path }) => path === selectionAnchorRef.current);
        const target = selectableDownloadNodes.findIndex(({ path }) => path === node.path);
        if (anchor >= 0 && target >= 0) {
          for (const candidate of selectableDownloadNodes.slice(Math.min(anchor, target), Math.max(anchor, target) + 1)) {
            if (next.has(candidate.path)) continue;
            if (next.size >= downloadLimits.maxFiles
              || totalBytes + candidate.entry.size > downloadLimits.maxTotalBytes) break;
            next.set(candidate.path, { path: candidate.path, name: candidate.entry.name, size: candidate.entry.size });
            totalBytes += candidate.entry.size;
          }
        }
      } else if (next.has(node.path)) {
        next.delete(node.path);
      } else if (next.size < downloadLimits.maxFiles
        && totalBytes + node.entry.size <= downloadLimits.maxTotalBytes) {
        next.set(node.path, nextSource);
      }
      return next;
    });
    selectionAnchorRef.current = node.path;
  }

  function toggleAllVisibleDownloads() {
    const allSelected = selectableDownloadNodes.length > 0
      && selectableDownloadNodes.every(({ path }) => selectedDownloads.has(path));
    if (allSelected) {
      setSelectedDownloads((current) => {
        const next = new Map(current);
        for (const node of selectableDownloadNodes) next.delete(node.path);
        return next;
      });
      return;
    }
    const next = new Map<string, BatchDownloadSource>();
    let total = 0;
    for (const node of selectableDownloadNodes) {
      if (next.size >= downloadLimits.maxFiles || total + node.entry.size > downloadLimits.maxTotalBytes) break;
      next.set(node.path, { path: node.path, name: node.entry.name, size: node.entry.size });
      total += node.entry.size;
    }
    setSelectedDownloads(next);
  }

  async function downloadSelectedFiles() {
    if (!binding || selectedDownloads.size === 0 || batchDownloadPreparing) return;
    const requestContext = treeRequestContext;
    setBatchDownloadPreparing(true);
    try {
      const selected = await openDialog({
        title: t("explorer.download.batch_choose_destination"),
        directory: true,
        multiple: false,
        ...(hostPrefs.lastDownloadDir ? { defaultPath: hostPrefs.lastDownloadDir } : {}),
      });
      const destinationRoot = Array.isArray(selected) ? selected[0] : selected;
      if (!destinationRoot || treeRequestContextRef.current !== requestContext) return;
      if (prefsKey) {
        useSessionsStore.getState().patchHostFilePrefs(prefsKey, (prefs) => rememberHostDownloadDir(prefs, destinationRoot));
      }
      const existing = await fsReadDir(destinationRoot, true);
      if (treeRequestContextRef.current !== requestContext) return;
      const requests = planBatchDownloads({
        sources: [...selectedDownloads.values()],
        destinationRoot,
        existingNames: existing.map(({ name }) => name),
        binding,
        limits: downloadLimits,
      });
      useTransferStore.getState().enqueueBatch(requests);
      setSelectedDownloads(new Map());
      selectionAnchorRef.current = null;
      useUIStore.getState().addToast({
        sessionId,
        title: t("explorer.download.batch_queued"),
        subtitle: t("explorer.download.batch_queued_hint", { count: requests.length }),
        variant: "success",
      });
    } catch {
      if (treeRequestContextRef.current === requestContext) {
        useUIStore.getState().addToast({
          sessionId,
          title: t("explorer.download.failed"),
          subtitle: t("explorer.download.batch_prepare_failed"),
          variant: "error",
        });
      }
    } finally {
      if (treeRequestContextRef.current === requestContext) setBatchDownloadPreparing(false);
    }
  }

  function renderTreeNode(node: ExplorerTreeNode) {
    const listingIndex = nodeIndexByPath.get(node.path) ?? -1;
    const isDir = node.entry.kind === "dir";
    const expanded = isDir && expandedPaths.has(node.path);
    const children = childrenByParent.get(node.path) ?? [];
    const active = activeFilePath === node.path;
    const batchSelectable = !!binding && node.entry.kind === "file" && node.entry.size <= downloadLimits.maxFileBytes;
    const batchSelected = selectedDownloads.has(node.path);
    const openMenu = (x: number, y: number, opener: HTMLElement) => {
      menuReturnPathRef.current = node.path;
      menuReturnFocusRef.current = opener;
      setContextMenu({ position: { x, y }, items: treeMenuItems(node), bindingKey: treeRequestContext });
    };
    return (
      <div
        key={node.path}
        role="treeitem"
        aria-label={node.entry.name}
        aria-level={node.level}
        aria-expanded={isDir ? expanded : undefined}
        aria-setsize={node.setSize}
        aria-posinset={node.posInSet}
        aria-selected={batchSelectable ? batchSelected : undefined}
        data-explorer-item
        data-listing-index={listingIndex}
        data-tree-path={node.path}
        data-drop-target={dropHighlightPath === node.path ? "true" : undefined}
        data-file-path={!isDir ? node.path : undefined}
        tabIndex={listingFocusIndex === listingIndex ? 0 : -1}
        onFocus={(event) => {
          if (event.target !== event.currentTarget) return;
          focusedPathRef.current = node.path;
          setListingFocusIndex(listingIndex);
        }}
        onClick={(event) => {
          const target = event.target as HTMLElement;
          if (target.closest("button, input")) return;
          const originItem = target.closest("[role=treeitem]");
          if (originItem && originItem !== event.currentTarget) return;
          if (batchSelectable && (event.ctrlKey || event.metaKey || event.shiftKey)) {
            toggleDownloadSelection(node, event.shiftKey);
            return;
          }
          if (isDir) {
            // A second click in a double-click enters the folder; the first
            // click still expands so nested children stay visible in the tree.
            if (event.detail > 1) {
              setNavDir("in");
              setCurrentPath(node.path);
              return;
            }
            if (expanded) collapsePath(node.path);
            else expandDirectory(node.path);
            return;
          }
          openFile(node.path);
        }}
        onContextMenu={(event) => { event.preventDefault(); openMenu(event.clientX, event.clientY, event.currentTarget); }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu") {
            event.preventDefault();
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            openMenu(rect.left + 8, rect.top + rect.height / 2, event.currentTarget);
            return;
          }
          if (event.key === "Enter") {
            event.preventDefault(); event.stopPropagation();
            if (isDir) { setNavDir("in"); setCurrentPath(node.path); } else openFile(node.path);
            return;
          }
          if (event.key === " " && batchSelectable) {
            event.preventDefault(); event.stopPropagation();
            toggleDownloadSelection(node, event.shiftKey);
            return;
          }
          if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
            event.preventDefault(); event.stopPropagation();
            const target = event.key === "Home" ? 0
              : event.key === "End" ? visibleTreeNodes.length - 1
                : listingIndex + (event.key === "ArrowDown" ? 1 : -1);
            focusTreeIndex(target);
            return;
          }
          if (event.key === "ArrowRight" && isDir) {
            event.preventDefault(); event.stopPropagation();
            if (!expanded) expandDirectory(node.path);
            else if (visibleTreeNodes[listingIndex + 1]?.parentPath === node.path) focusTreeIndex(listingIndex + 1);
            return;
          }
          if (event.key === "ArrowLeft") {
            if (isDir && expanded) {
              event.preventDefault(); event.stopPropagation();
              collapsePath(node.path);
            } else if (node.parentPath) {
              event.preventDefault(); event.stopPropagation();
              focusTreeIndex(nodeIndexByPath.get(node.parentPath) ?? -1);
            }
            return;
          }
          if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.preventDefault(); event.stopPropagation();
            window.clearTimeout(typeaheadRef.current.timer);
            const nextText = `${typeaheadRef.current.text}${event.key.toLocaleLowerCase()}`;
            const query = nextText.split("").every((character) => character === nextText[0])
              ? nextText[0]
              : nextText;
            typeaheadRef.current.text = query;
            typeaheadRef.current.timer = window.setTimeout(() => { typeaheadRef.current.text = ""; }, 500);
            for (let offset = 1; offset <= visibleTreeNodes.length; offset += 1) {
              const index = (listingIndex + offset) % visibleTreeNodes.length;
              if (visibleTreeNodes[index].entry.name.toLocaleLowerCase().startsWith(query)) { focusTreeIndex(index); break; }
            }
          }
        }}
        className="explorer-tree-node"
        style={{ width: "100%", marginBottom: 2, cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "stretch" }}
      >
        <div
          className="hover-bg"
          style={{
            minHeight: 30,
            padding: `0 var(--sp-1) 0 ${8 + (node.level - 1) * 16}px`,
            borderRadius: "var(--r-btn)",
            border: dropHighlightPath === node.path ? "1px dashed var(--c-accent)" : "none",
            background: dropHighlightPath === node.path ? "color-mix(in srgb, var(--c-accent) 12%, transparent)" : batchSelected || active ? "var(--c-accent-bg-light)" : "transparent",
            display: "grid",
            gridTemplateColumns: binding ? "20px minmax(0, 1fr) minmax(42px, 92px) 28px" : "minmax(0, 1fr) minmax(42px, 92px) 28px",
            columnGap: 4,
            alignItems: "center",
            textAlign: "left",
          }}
        >
        {binding && (
          <input
            type="checkbox"
            className="ui-choice"
            aria-label={node.entry.kind === "file" ? t("explorer.download.select_file", { file: node.entry.name }) : undefined}
            checked={batchSelected}
            disabled={!batchSelectable}
            title={node.entry.kind === "file" && node.entry.size > downloadLimits.maxFileBytes ? t("explorer.download.too_large") : undefined}
            onClick={(event) => { event.stopPropagation(); toggleDownloadSelection(node, event.shiftKey); }}
            onChange={() => {}}
            style={{ margin: 0, visibility: node.entry.kind === "file" ? "visible" : "hidden" }}
          />
        )}
        <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, height: 30 }}>
          {isDir ? (
            <button
              type="button"
              tabIndex={-1}
              className="explorer-tree-toggle hover-bg"
              aria-label={expanded ? t("dir_group.collapse_named", { name: node.entry.name }) : t("dir_group.expand_named", { name: node.entry.name })}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (expanded) collapsePath(node.path);
                else expandDirectory(node.path);
              }}
            >
              <FolderIcon />
              <TreeChevron expanded={expanded} />
            </button>
          ) : (
            <span aria-hidden="true" style={{ display: "flex", pointerEvents: "none" }}><FileIcon /></span>
          )}
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--c-text-2)", pointerEvents: "none" }}>{node.entry.name}</span>
        </span>
        <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)", textAlign: "right", pointerEvents: "none" }}>{formatModifiedTime(node.entry.mtime)}</span>
        <button
          type="button"
          tabIndex={-1}
          className="hover-bg"
          aria-label={`${t("common.more_actions")}: ${node.entry.name}`}
          title={t("common.more_actions")}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            openMenu(rect.right, rect.bottom, event.currentTarget);
          }}
          style={{ width: 26, height: 26, padding: 0, border: 0, borderRadius: "var(--r-btn)", background: "transparent", color: "var(--c-text-4)", cursor: "pointer" }}
        >
          <span aria-hidden="true">⋯</span>
        </button>
        </div>
        {isDir && expanded && children.length > 0 && (
          <div role="group">
            {children.map(renderTreeNode)}
          </div>
        )}
        {isDir && expanded && treeErrors[node.path]?.kind === "readFailed" && (
          <div role="group" style={{ padding: "2px 0 4px 22px" }}>
            <div role="alert" style={{ color: "var(--c-error)", fontSize: "var(--fs-meta)" }}>
              {t("explorer.read_dir_failed")}
            </div>
            <button type="button" className="ui-button" onClick={() => expandDirectory(node.path)}>
              {t("explorer.search_retry")}
            </button>
          </div>
        )}
      </div>
    );
  }

  function openSearchDir(path: string) {
    search.setQuery("");
    setNavDir("in");
    setCurrentPath(path);
  }

  function openFile(path: string) {
    const owner = useSessionsStore.getState().sessions.find((session) => session.id === sessionId);
    if (!owner) return;
    void openResource(resourceRefForSession(owner, path), "preview");
  }

  function changeSort(key: SortKey) {
    setSort((current) => current.key === key
      ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
      : { key, direction: key === "modified" ? "desc" : "asc" });
  }

  return (
    <div
      ref={explorerRef}
      onDragEnter={(event) => { event.preventDefault(); if (binding) setDropActive(true); }}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false); }}
      onDrop={(event) => { event.preventDefault(); setDropActive(false); }}
      style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, position: "relative", overflow: "hidden", outline: dropActive ? "2px dashed var(--c-accent)" : undefined, outlineOffset: -3 }}
    >
      {dropActive && (
        <div role="status" style={{ flexShrink: 0, padding: "7px var(--sp-2)", borderBottom: "1px dashed var(--c-accent)", fontWeight: 600, textAlign: "center" }}>
          ↥ {dropHighlightPath ? t("explorer.drop.on_folder", { path: dropHighlightPath }) : t("explorer.drop.ready")}
        </div>
      )}
      {dropMessage && <div role="status" aria-live="polite" className="sr-only">{dropMessage}</div>}
      {remoteDisconnected && (
        <div role="status" aria-live="polite" style={{ flexShrink: 0, padding: "5px var(--sp-2)", color: "var(--c-warning)", background: "color-mix(in srgb, var(--c-warning) 8%, transparent)", borderBottom: "1px solid var(--c-border-1)", fontSize: "var(--fs-meta)" }}>
          {t("explorer.remote_disconnected")}
        </div>
      )}
      <ExplorerNav
        t={t}
        canGoUp={canGoUp}
        onGoUp={goUp}
        currentPath={currentPath}
        breadcrumbRoot={breadcrumbRoot}
        onNavigate={(path) => { setNavDir("out"); setCurrentPath(path); }}
        onRefresh={refresh}
      />
      <ExplorerSearchRow
        t={t}
        searchMode={searchMode}
        searchQuery={searchQuery}
        onToggleSearchMode={search.toggleSearchMode}
        onQueryChange={search.setQuery}
        onClearQuery={() => search.setQuery("")}
        includeHidden={includeHidden}
        onToggleHidden={() => setIncludeHidden((v) => !v)}
        onInputKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            if (searchQuery) search.setQuery("");
            else event.currentTarget.blur();
            return;
          }
          if (event.key !== "ArrowDown") return;
          const first = resultsListRef.current?.querySelector<HTMLElement>("[data-explorer-item]");
          if (!first) return;
          event.preventDefault();
          first.focus();
        }}
      />
      {isRemote && (
        <ExplorerRemoteTools
          t={t}
          bindingKey={treeRequestContext}
          showPlaces={Boolean(prefsKey)}
          followTerminalCwd={followTerminalCwd}
          onToggleFollowCwd={() => {
            if (!prefsKey) return;
            useSessionsStore.getState().patchHostFilePrefs(prefsKey, (prefs) => ({ ...prefs, followTerminalCwd: !prefs.followTerminalCwd }));
          }}
          isFavorite={hostPrefs.favoritePaths.includes(currentPath)}
          onToggleFavorite={() => {
            if (!prefsKey) return;
            useSessionsStore.getState().patchHostFilePrefs(prefsKey, (prefs) => toggleHostFavoritePath(prefs, currentPath));
          }}
          listingRoot={remoteExplorerListingRoot()}
          homeDir={homeDir}
          currentPath={currentPath}
          favoritePaths={hostPrefs.favoritePaths}
          recentPaths={hostPrefs.recentPaths}
          onJumpToPath={(path) => { setNavDir("in"); setCurrentPath(path); }}
          remoteDisconnected={remoteDisconnected}
          uploadBusy={upload !== null}
          onUploadFile={() => { void uploadToRemoteDirectory(currentPath); }}
          showFolderTransfer={Boolean(binding)}
          onUploadFolder={() => { void uploadFolderToRemoteDirectory(currentPath); }}
          selectedDownloadCount={selectedDownloads.size}
          batchDownloadPreparing={batchDownloadPreparing}
          onDownloadSelected={() => { void downloadSelectedFiles(); }}
          activeTransferNotice={activeTransferNotice}
          onOpenTransfers={() => {
            useUIStore.getState().setPanelVisible(true);
            useUIStore.getState().setInspectorTab("transfers");
          }}
        />
      )}

      {upload && (
        <div className="explorer-transfer-status">
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "var(--fs-meta)", color: "var(--c-text-3)" }}>
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
              {upload.cancelling ? t("explorer.upload.cancelling") : t("explorer.upload.progress", { file: upload.fileName, percent: upload.total > 0 ? Math.min(100, Math.round(upload.transferred / upload.total * 100)) : 0 })}
            </span>
            <button type="button" onClick={directUpload.cancelUpload} disabled={upload.cancelling} className="hover-bg" style={{ border: "none", background: "transparent", color: "var(--c-text-4)", cursor: upload.cancelling ? "default" : "pointer", padding: "2px 5px", borderRadius: "var(--r-btn)", fontSize: "var(--fs-meta)" }}>{t("explorer.upload.cancel")}</button>
          </div>
          <progress className="ui-progress" aria-label={t("explorer.upload.progress_label")} max={upload.total || 1} value={upload.transferred} style={{ display: "block", width: "100%", height: 4, marginTop: 5 }} />
        </div>
      )}
      <div aria-live="polite" aria-atomic="true" className="sr-only" data-transfer-announcement>
        {transferAnnouncement}
      </div>
      {download && (
        <div className="explorer-transfer-status" role="status" aria-live="polite" aria-busy="true" title={download.fileName}>
          {t("explorer.download.progress", { file: download.fileName })}
          <progress className="ui-progress" aria-label={t("explorer.download.progress_label")} style={{ display: "block", width: "100%", height: 4, marginTop: 5 }} />
        </div>
      )}

      <div
        key={contentKey}
        ref={resultsListRef}
        onKeyDown={(e) => {
          // 结果/树列表方向键漫游：↑↓ 在列表内按钮间移动焦点
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          const list = e.currentTarget as HTMLElement;
          const active = document.activeElement as HTMLElement | null;
          const listingIndex = active?.dataset.listingIndex;
          if (virtualizeListing && listingIndex !== undefined) {
            e.preventDefault();
            const current = Number(listingIndex);
            const targetIndex = Math.max(0, Math.min(
              listingRowCount - 1,
              current + (e.key === "ArrowDown" ? 1 : -1),
            ));
            if (targetIndex === current) return;
            const mountedTarget = list.querySelector<HTMLElement>(`[data-listing-index="${targetIndex}"]`);
            if (mountedTarget) {
              setListingFocusIndex(targetIndex);
              mountedTarget.focus();
              return;
            }
            const rowTop = LISTING_TOP_INSET + targetIndex * LISTING_ROW_HEIGHT;
            const nextTop = rowTop < list.scrollTop
              ? rowTop
              : Math.max(0, rowTop + LISTING_ROW_HEIGHT - list.clientHeight);
            list.scrollTop = nextTop;
            setListScroll({ top: nextTop, height: list.clientHeight });
            setListingFocusIndex(targetIndex);
            setPendingListingFocus(targetIndex);
            return;
          }
          const items = Array.from(list.querySelectorAll<HTMLElement>("[data-explorer-item]"));
          if (items.length === 0) return;
          e.preventDefault();
          const idx = items.indexOf(active as HTMLElement);
          if (idx === -1) return;
          const next = e.key === "ArrowDown"
            ? items[Math.min(idx + 1, items.length - 1)]
            : items[Math.max(idx - 1, 0)];
          next?.focus();
        }}
        style={{ flex: 1, overflowY: "auto", padding: "6px var(--sp-2)", animation: !isSearching && navDir ? `${navDir === "in" ? "slideInRight" : "slideInLeft"} var(--duration-normal) var(--ease-out-expo)` : undefined }}
        className="no-scrollbar scroll-fade-y"
      >
        {isSearching ? (
          searchMode === "content" ? (
            searchLoading && grepHits.length === 0 ? (
              <PanelLoadingState label={t("explorer.searching")} />
            ) : searchError ? (
              <>
                <PanelEmptyState label={t("explorer.search_failed")} sublabel={searchQuery.trim()} />
                <SearchRetryButton label={t("explorer.search_retry")} onRetry={search.retrySearch} />
              </>
            ) : grepHits.length === 0 ? (
              <PanelEmptyState label={t("explorer.content_no_match")} sublabel={searchQuery.trim()} />
            ) : (
              <>
                <div style={{ padding: "3px 6px 7px", display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: "var(--fs-meta)", lineHeight: "16px", color: "var(--c-text-5)", fontFamily: "var(--font-mono)" }}>{t("explorer.results")}</span>
                  <span style={{ fontSize: "var(--fs-meta)", lineHeight: "16px", color: "var(--c-text-5)", background: "var(--c-bg-3)", borderRadius: "var(--r-pill)", padding: "0 6px", fontFamily: "var(--font-mono)", minWidth: 18, textAlign: "center" }}>{grepHits.length}</span>
                </div>
                {grepHits.map((group) => (
                  <div key={group.path} style={{ marginBottom: 6 }}>
                    <div style={{ padding: "3px var(--sp-2)", display: "flex", alignItems: "center", gap: 6 }}>
                      <FileIcon />
                      <span style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-3)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)" }} title={group.rel}>{compactRelativePath(group.rel)}</span>
                      <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", background: "var(--c-bg-3)", borderRadius: "var(--r-pill)", padding: "0 6px", fontFamily: "var(--font-mono)", minWidth: 18, textAlign: "center", flexShrink: 0 }}>{group.lines.length}</span>
                    </div>
                    {group.lines.map((ln) => (
                      <button
                        key={ln.line}
                        data-explorer-item
                        // Content hits open the owning file tab. Keeping local
                        // and SSH results on the same workspace surface avoids
                        // sending remote paths to a local external editor.
                        onClick={() => openFile(group.path)}
                        title={group.rel}
                        className="hover-bg"
                        style={{ width: "100%", padding: "2px var(--sp-2) 2px 30px", borderRadius: "var(--r-btn)", border: "none", background: "transparent", cursor: "pointer", display: "flex", alignItems: "flex-start", gap: 8, textAlign: "left", marginBottom: 1 }}
                      >
                        <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-6)", fontFamily: "var(--font-mono)", flexShrink: 0, minWidth: 28, textAlign: "right" }}>{ln.line}</span>
                        <span style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-2)", fontFamily: "var(--font-mono)", whiteSpace: "pre", overflow: "hidden" }}>{ln.text}</span>
                      </button>
                    ))}
                  </div>
                ))}
                {(grepTruncated || searchLoading) && <SearchLimitControl canLoadMore={searchLimit < searchMaxLimit} loading={searchLoading} onLoadMore={search.loadMoreSearchResults} />}
              </>
            )
          ) : (
          searchLoading && searchHits.length === 0 ? (
            <PanelLoadingState label={t("explorer.searching")} />
          ) : searchError ? (
            <>
              <PanelEmptyState label={t("explorer.search_failed")} sublabel={searchQuery.trim()} />
              <SearchRetryButton label={t("explorer.search_retry")} onRetry={search.retrySearch} />
            </>
          ) : searchHits.length === 0 ? (
            <PanelEmptyState label={t("explorer.no_match")} sublabel={searchQuery.trim()} />
          ) : (
            <>
              <div style={{ padding: "3px 6px 7px", display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: "var(--fs-meta)", lineHeight: "16px", color: "var(--c-text-5)", fontFamily: "var(--font-mono)" }}>{t("explorer.results")}</span>
                <span style={{ fontSize: "var(--fs-meta)", lineHeight: "16px", color: "var(--c-text-5)", background: "var(--c-bg-3)", borderRadius: "var(--r-pill)", padding: "0 6px", fontFamily: "var(--font-mono)", minWidth: 18, textAlign: "center" }}>{searchHits.length}</span>
              </div>
              {searchHits.map((hit) => {
                const isExpanded = activeFilePath === hit.path;
                return (
                  <div key={hit.path}>
                    <button
                      data-explorer-item
                      onClick={() => hit.isDir ? openSearchDir(hit.path) : openFile(hit.path)}
                      className="hover-bg"
                      style={{
                        width: "100%", height: 30, padding: "0 var(--sp-2)", borderRadius: "var(--r-btn)", border: "none",
                        background: isExpanded ? "var(--c-accent-bg-light)" : "transparent",
                        cursor: "pointer", display: "flex", alignItems: "center", gap: 6, textAlign: "left", marginBottom: 2,
                      }}
                    >
                      {hit.isDir ? <FolderIcon /> : <FileIcon />}
                      <span style={{ fontSize: "var(--fs-secondary)", color: isExpanded ? "var(--c-text-primary)" : "var(--c-text-2)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)" }} title={hit.rel}>{compactRelativePath(hit.rel)}</span>
                      {hit.isDir && <TreeChevron />}
                    </button>
                  </div>
                );
              })}
              {(searchTruncated || searchLoading) && <SearchLimitControl canLoadMore={searchLimit < searchMaxLimit} loading={searchLoading} onLoadMore={search.loadMoreSearchResults} />}
            </>
          )
          )
        ) : loading ? (
          <PanelLoadingState label={t("explorer.loading")} />
        ) : error ? (
          <PanelEmptyState label={t("explorer.read_dir_failed")} sublabel={currentPath} />
        ) : entries.length === 0 ? (
          <PanelEmptyState icon={folderEmptyIcon} label={t("explorer.dir_empty")} />
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: binding ? "20px minmax(0, 1fr) 92px" : "minmax(0, 1fr) 92px", columnGap: 6, alignItems: "center", height: 24, padding: "0 var(--sp-2)", marginBottom: 3, borderBottom: "1px solid var(--c-border-1)" }}>
              {binding && (
                <input
                  type="checkbox"
                  className="ui-choice"
                  aria-label={t("explorer.download.select_all")}
                  checked={selectableDownloadNodes.length > 0 && selectableDownloadNodes.every(({ path }) => selectedDownloads.has(path))}
                  disabled={selectableDownloadNodes.length === 0}
                  onChange={toggleAllVisibleDownloads}
                  style={{ margin: 0 }}
                />
              )}
              {(["name", "modified"] as const).map((key) => {
                const active = sort.key === key;
                const label = t(key === "name" ? "explorer.column.name" : "explorer.column.modified");
                const directionLabel = t(sort.direction === "asc" ? "explorer.sort.ascending" : "explorer.sort.descending");
                return (
                  <div key={key}>
                    <button
                      type="button"
                      onClick={() => changeSort(key)}
                      className="explorer-sort-button"
                      title={active ? `${label}, ${directionLabel}` : label}
                      aria-label={active ? `${label}, ${directionLabel}` : label}
                      aria-pressed={active}
                    >
                      <span>{label}</span>
                      <span className="explorer-sort-direction" data-visible={active ? "true" : "false"} aria-hidden="true">
                        {sort.direction === "asc" ? "↑" : "↓"}
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
            <div role="tree" aria-label={t("explorer.file_list")} aria-multiselectable={binding ? "true" : undefined}>
              {virtualizeListing && <div aria-hidden="true" role="presentation" style={{ height: listingSlice.topPad }} />}
              {(childrenByParent.get(null) ?? [])
                .slice(listingSlice.first, listingSlice.last)
                .map(renderTreeNode)}
              {virtualizeListing && <div aria-hidden="true" role="presentation" style={{ height: listingSlice.bottomPad }} />}
            </div>
          </>
        )}
      </div>

      {propertiesPath && binding && (
        <Modal
          labelledBy="remote-metadata-title"
          onRequestClose={() => setPropertiesPath(null)}
          bindingKey={treeRequestContext}
          currentBindingKey={treeRequestContext}
          style={{ width: 480 }}
        >
          <RemoteMetadataPanel binding={binding} path={propertiesPath} host={remoteHost ?? sessionId} />
          <div style={{ display: "flex", justifyContent: "flex-end", padding: "0 12px 12px" }}>
            <button type="button" className="ui-button" onClick={() => setPropertiesPath(null)}>{t("common.close")}</button>
          </div>
        </Modal>
      )}

      {mutationComposer && (
        <>
          <div aria-hidden="true" style={{ position: "fixed", inset: 0, background: "var(--backdrop-color)", zIndex: 318 }} />
          <div
            ref={mutationComposerRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="remote-mutation-name-title"
            style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)", width: 420, maxWidth: "calc(100vw - 32px)", padding: 18, zIndex: 319, background: "var(--c-bg-white)", borderRadius: "var(--r-overlay)", boxShadow: "var(--shadow-overlay)", display: "grid", gap: 12 }}
          >
            <strong id="remote-mutation-name-title">{t(`explorer.mutation.${mutationComposer.kind}`)}</strong>
            <label>
              {t("explorer.mutation.name")}
              <input
                className="ui-control"
                autoFocus
                value={mutationComposer.value}
                onChange={(event) => setMutationComposer((current) => current ? { ...current, value: event.target.value } : current)}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void prepareNamedMutation(); } }}
              />
            </label>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" className="ui-button" onClick={() => { setMutationComposer(null); restoreMenuFocus(); }} disabled={mutationBusy}>{t("common.cancel")}</button>
              <button type="button" className="ui-button ui-button--primary" onClick={() => { void prepareNamedMutation(); }} disabled={mutationBusy || !mutationComposer.value.trim()}>{t("common.continue")}</button>
            </div>
          </div>
        </>
      )}

      {mutationRequest && mutationRequestIsCurrent && (
        <RemoteFsMutationDialog
          host={remoteHost ?? sessionId}
          request={mutationRequest}
          onClose={() => {
            setMutationRequest(null);
            restoreMenuFocus();
          }}
          onComplete={() => refresh()}
        />
      )}

      {contextMenu && (
        <ContextMenu
          items={contextMenu.items}
          position={contextMenu.position}
          bindingKey={contextMenu.bindingKey}
          currentBindingKey={treeRequestContext}
          returnFocusToken={menuReturnFocusRef}
          onClose={() => {
            setContextMenu(null);
            if (suppressMenuFocusRef.current) {
              suppressMenuFocusRef.current = false;
              return;
            }
          }}
        />
      )}
    </div>
  );
}
