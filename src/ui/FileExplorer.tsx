import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { computeVirtualSlice } from "./lib/diff-virtual";

/** Fixed row height shared by navigation, DnD and virtualization. */
const LISTING_ROW_HEIGHT = 32;
/** 滚动容器上内边距 6px + 表头 24px + 表头下边距 3px。 */
const LISTING_TOP_INSET = 33;
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { fsReadDir, fsResolveDir, type DirEntry, type SearchHit } from "@/modules/fs/fs-bridge";
import type { GrepFileGroup } from "@/modules/fs/lib/grep-group";
import {
  invalidateRemoteSearchCache,
  sshHome,
  sshReadDir,
} from "@/modules/ssh/remote-fs-bridge";
import { formatSize } from "./types";
import { PanelEmptyState, PanelLoadingState, PanelState } from "./shared";
import { DotsThree, Icon } from "@/ui/icons";
import { ContextMenu, type MenuEntry } from "./ContextMenu";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { openResource, resourceRefForSession } from "@/modules/resources/resource-ref";
import { openInEditorWithToast } from "./lib/open-in-editor";
import { errorToast } from "./lib/error-toast";
import { useT } from "@/modules/i18n";
import { ExplorerNav, ExplorerRemoteTools, ExplorerSearchRow } from "./file-explorer/chrome";
import { copyText } from "./lib/clipboard";
import { knownRemoteExplorerRoot, remoteExplorerListingRoot, remoteExplorerSearchRoot } from "./lib/file-explorer-root";
import { openRemoteInExternalEditor } from "@/modules/ssh/remote-external-edit";
import { dropDestinationFromListing, type DropListingNode } from "@/modules/ssh/drop-target";
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
import { ExplorerEntryName } from "./file-explorer/entry-name";
import { fileKindTint } from "./file-explorer/file-kind";
import {
  compactRelativePath,
  formatModifiedTime,
  joinPath,
  nextOperationId,
  parentPath,
  sortExplorerEntries,
  usableExplorerEntries,
  type SortDirection,
  type SortKey,
} from "./file-explorer/helpers";
import { downloadFailureKey } from "./file-explorer/transfer-failures";
import { queueLocalTransferPaths } from "./file-explorer/upload-preflight";
import { useExplorerSearch } from "./file-explorer/use-explorer-search";
import { mountedTreeRowIndexes } from "./file-explorer/tree-virtual";
import { useDirectUpload } from "./file-explorer/use-direct-upload";
import { SearchViewport } from "./file-explorer/search-viewport";
import { useExplorerViewport } from "./file-explorer/use-explorer-viewport";
import { recordFrontendPerf } from "@/modules/perf/benchmark-counters";

// Re-exported for existing importers/tests; implementations moved to ./file-explorer/.
export { downloadFailureKey, parseUploadFailure, uploadFailureKey, type UploadFailure } from "./file-explorer/transfer-failures";
export { sortExplorerEntries, formatModifiedTime } from "./file-explorer/helpers";

const GREP_HEADER_HEIGHT = 24;
const GREP_LINE_HEIGHT = 22;
type ListingNode = { path: string; entry: DirEntry };

type SearchRow = { key: string; height: number; focusable: boolean } & (
  | { kind: "name"; hit: SearchHit }
  | { kind: "group"; group: GrepFileGroup }
  | { kind: "line"; group: GrepFileGroup; ln: GrepFileGroup["lines"][number] }
);

interface FileExplorerProps {
  active?: boolean;
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

export function FileExplorer({
  active = true,
  sessionId,
  rootDir,
  remotePtyId,
  transportGeneration,
  remote = remotePtyId !== undefined,
  remoteHost,
}: FileExplorerProps) {
  recordFrontendPerf("renders");
  const t = useT();
  const isRemote = remote;
  const remoteDisconnected = isRemote && remotePtyId === undefined;
  const remoteSession = useSessionsStore((state) => state.sessions.find((session) => session.id === sessionId));
  const remoteInfo = remoteSession?.remote;
  const prefsKey = remoteInfo ? hostFilePrefsKey(remoteInfo) : null;
  const storedPrefs = useSessionsStore((state) => (prefsKey ? state.hostFilePrefs[prefsKey] : undefined));
  const hostPrefs = storedPrefs ?? emptyHostFilePrefs();
  const followTerminalCwd = isRemote && hostPrefs.followTerminalCwd;
  const directUpload = useDirectUpload({ sessionId, remotePtyId, t, onUploaded: () => refresh() });
  const { upload, transferAnnouncement } = directUpload;
  const downloadChooserPendingRef = useRef<object | null>(null);
  const [selectedDownloads, setSelectedDownloads] = useState<Map<string, BatchDownloadSource>>(() => new Map());
  const [selectingDownloads, setSelectingDownloads] = useState(false);
  const [batchDownloadPreparing, setBatchDownloadPreparing] = useState(false);
  const selectionAnchorRef = useRef<string | null>(null);
  const copyPathWithFeedback = async (path: string) => {
    const ok = await copyText(path);
    useUIStore.getState().addToast({
      sessionId,
      title: t(ok ? "clipboard.copy_success" : "common.copy_failed"),
      subtitle: "",
      variant: ok ? "success" : "error",
    });
  };

  const downloadRemoteFile = async (remotePath: string, fileName: string) => {
    if (!binding || downloadChooserPendingRef.current) return;
    const chooser = {};
    downloadChooserPendingRef.current = chooser;
    try {
      const localPath = await saveDialog({
        title: t("explorer.download.choose_destination"),
        defaultPath: fileName,
      });
      if (!localPath || downloadChooserPendingRef.current !== chooser) return;
      useTransferStore.getState().enqueue({
        binding,
        direction: "download",
        source: remotePath,
        destination: localPath,
        conflict: "replace",
      });
    } catch (error) {
      useUIStore.getState().addToast(errorToast({
        sessionId,
        title: t("explorer.download.failed"),
        next: t(downloadFailureKey(error)),
        error,
      }));
    } finally {
      if (downloadChooserPendingRef.current === chooser) downloadChooserPendingRef.current = null;
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
      if (!destinationParent || treeRequestContextRef.current !== treeRequestContext) return;
      const manifest = await validateManifest(
        { kind: "remote", root: remotePath, binding },
        { maxEntries: downloadLimits.maxFiles, maxTotalBytes: downloadLimits.maxTotalBytes },
      );
      if (treeRequestContextRef.current !== treeRequestContext) return;
      const plan = expandFolderTransfer({
        manifest,
        binding,
        direction: "download",
        sourceRoot: remotePath,
        destinationRoot: joinPath(destinationParent, folderName),
        conflict: "rename",
      });
      useTransferStore.getState().enqueueBatch(plan.requests);
    } catch (error) {
      useUIStore.getState().addToast(errorToast({
        sessionId,
        title: t("explorer.download.failed"),
        next: t("explorer.download.batch_prepare_failed"),
        error,
      }));
    }
  };
  // Local and remote both start at the session cwd and can browse up to `/`.
  // OSC 7 / SFTP home are only the first location for SSH, not a cage.
  const [baseDir, setBaseDir] = useState<string | null>(isRemote ? null : rootDir);
  const [homeDir, setHomeDir] = useState<string | null>(null);
  const [localHomeDir, setLocalHomeDir] = useState<string | null>(null);
  useEffect(() => {
    if (isRemote || !rootDir.startsWith("/")) return;
    let cancelled = false;
    fsResolveDir("~").then((home) => { if (!cancelled) setLocalHomeDir(home); }).catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- home only needs resolving once per explorer
  }, [isRemote]);
  const currentPath = useUIStore((state) => state.explorerPaths[sessionId] ?? (isRemote ? "" : rootDir));
  const history = useUIStore((state) => state.explorerHistory[sessionId]);
  const setCurrentPath = useCallback((next: string | ((current: string) => string)) => {
    useUIStore.getState().setExplorerPath(sessionId, next, isRemote ? "" : rootDir);
  }, [sessionId, isRemote, rootDir]);
  const previousCwdFollow = useRef({ rootDir, followTerminalCwd });
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [cachedListingKey, setCachedListingKey] = useState<string | null>(null);
  const listingCacheKey = `${isRemote ? "remote" : "local"}\0${sessionId}\0${currentPath}`;
  const hasCachedListing = cachedListingKey === listingCacheKey;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [navDir, setNavDir] = useState<"in" | "out" | null>(null);
  const [includeHidden, setIncludeHidden] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [uploadReloadKey, setUploadReloadKey] = useState(0);
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({ key: "name", direction: "asc" });
  const searchRoot = remoteExplorerSearchRoot(currentPath, isRemote ? homeDir : baseDir);
  const search = useExplorerSearch({ baseDir: searchRoot, includeHidden, reloadKey: reloadKey + uploadReloadKey, isRemote, remotePtyId, remoteDisconnected });
  const {
    searchQuery,
    searchMode,
    searchHits,
    grepHits,
    searchLoading,
    searchError,
    searchUnreadable,
    searchTruncated,
    grepTruncated,
    searchLimit,
    searchMaxLimit,
    isSearching,
  } = search;
  const searchRows = useMemo<SearchRow[]>(() => {
    if (!isSearching) return [];
    if (searchMode === "name") {
      return searchHits.map((hit) => ({ kind: "name", key: hit.path, height: LISTING_ROW_HEIGHT, focusable: true, hit }));
    }
    return grepHits.flatMap((group): SearchRow[] => [
      { kind: "group", key: group.path, height: GREP_HEADER_HEIGHT, focusable: false, group },
      ...group.lines.map((ln, index): SearchRow => ({
        kind: "line", key: `${ln.line}:${group.path}`, height: GREP_LINE_HEIGHT + (index === group.lines.length - 1 ? 6 : 0),
        focusable: true, group, ln,
      })),
    ]);
  }, [grepHits, isSearching, searchHits, searchMode]);
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
    s.readers[sessionId]?.current?.filePath,
  );
  const treeListRef = useRef<HTMLDivElement>(null);
  const focusFirstSearchResultRef = useRef<() => boolean>(null);
  const focusAfterNavigationRef = useRef<string | null>(null);
  const [pendingListingFocus, setPendingListingFocus] = useState<number | null>(null);
  const [listingFocusIndex, setListingFocusIndex] = useState(0);
  const explorerRef = useRef<HTMLDivElement>(null);
  const listingDropRef = useRef<{ currentPath: string; nodes: DropListingNode[] }>({ currentPath: "", nodes: [] });
  const [dropActive, setDropActive] = useState(false);
  const [dropHighlightPath, setDropHighlightPath] = useState<string | null>(null);
  const [dropMessage, setDropMessage] = useState("");
  const [mutationPrepareError, setMutationPrepareError] = useState("");
  const [mutationComposer, setMutationComposer] = useState<{ kind: "mkdir" | "rename"; node: ListingNode; value: string; bindingKey: string; error?: string } | null>(null);
  const [properties, setProperties] = useState<{ path: string; bindingKey: string } | null>(null);
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
  const listingNodes = useMemo<ListingNode[]>(() => {
    if (!hasCachedListing) return [];
    const usable = usableExplorerEntries(entries);
    return [
      ...sortExplorerEntries(usable.filter((entry) => entry.kind === "dir"), sort.key, sort.direction),
      ...sortExplorerEntries(usable.filter((entry) => entry.kind !== "dir"), sort.key, sort.direction),
    ].map((entry) => ({ entry, path: joinPath(currentPath, entry.name) }));
  }, [hasCachedListing, entries, currentPath, sort]);
  const nodeIndexByPath = useMemo(() => new Map(listingNodes.map(({ path }, index) => [path, index])), [listingNodes]);
  const isConfirmedMissingFile = useCallback((path: string) => (
    listingNodes[nodeIndexByPath.get(path) ?? -1]?.entry.kind !== "file"
  ), [listingNodes, nodeIndexByPath]);
  const selectionContext = useRef(treeRequestContext);
  useEffect(() => {
    if (selectionContext.current === treeRequestContext) return;
    selectionContext.current = treeRequestContext;
    if (!remoteDisconnected) {
      setSelectedDownloads(new Map());
      setSelectingDownloads(false);
    }
    selectionAnchorRef.current = null;
    setBatchDownloadPreparing(false);
  }, [treeRequestContext, remoteDisconnected]);
  const downloadListingRef = useRef<typeof isConfirmedMissingFile | null>(null);
  downloadListingRef.current = hasCachedListing ? isConfirmedMissingFile : null;
  useEffect(() => {
    if (remoteDisconnected || !hasCachedListing) return;
    if (selectionAnchorRef.current && isConfirmedMissingFile(selectionAnchorRef.current)) selectionAnchorRef.current = null;
    setSelectedDownloads((current) => {
      if (current.size === 0) return current;
      const next = new Map([...current].filter(([path]) => !isConfirmedMissingFile(path)));
      return next.size === current.size ? current : next;
    });
  }, [hasCachedListing, isConfirmedMissingFile, remoteDisconnected]);
  const closeTransientControls = useCallback(() => {
    setContextMenu(null);
    setProperties(null);
    setMutationComposer(null);
    setMutationRequest(null);
    setDropActive(false);
    setDropHighlightPath(null);
  }, []);
  useEffect(() => closeTransientControls, [closeTransientControls]);
  useEffect(() => {
    if (remoteDisconnected) closeTransientControls();
  }, [closeTransientControls, remoteDisconnected]);
  const mutationComposerRef = useRef<HTMLDivElement>(null);
  const menuReturnFocusRef = useRef<HTMLElement>(null);
  useModalBehavior(mutationComposerRef, {
    active: active && !remoteDisconnected && mutationComposer !== null,
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
  const [menuReturnPath, setMenuReturnPath] = useState<string | null>(null);
  const suppressMenuFocusRef = useRef(false);
  const typeaheadRef = useRef({ text: "", timer: 0 });
  const binding = useMemo<SessionBindingV1 | null>(() => isRemote
    && remotePtyId !== undefined
    && transportGeneration
    ? { logicalSessionId: sessionId, physicalPtyId: remotePtyId, transportGeneration }
    : null, [isRemote, remotePtyId, sessionId, transportGeneration]);
  useEffect(() => () => { downloadChooserPendingRef.current = null; }, [binding]);
  useLayoutEffect(() => {
    if (!binding || !currentPath.startsWith("/")) return;
    const directory = currentPath.replace(/\/+$/, "") || "/";
    return useTransferStore.subscribe((state, previous) => {
      const upload = state.lastCompletedUpload;
      if (upload && upload !== previous.lastCompletedUpload
        && upload.binding.logicalSessionId === binding.logicalSessionId
        && upload.binding.physicalPtyId === binding.physicalPtyId
        && upload.binding.transportGeneration === binding.transportGeneration) {
        const targetDir = parentPath(upload.destination);
        if (targetDir === directory) {
          invalidateRemoteSearchCache(binding.physicalPtyId);
          setUploadReloadKey((n) => n + 1);
        } else if (directory === "/" || targetDir.startsWith(`${directory}/`)) {
          invalidateRemoteSearchCache(binding.physicalPtyId);
        }
      }
    });
  }, [binding, currentPath]);
  const activeTransferNotice = useTransferStore((s) =>
    (s.aggregateBySession.get(sessionId)?.queued ?? 0) + (s.aggregateBySession.get(sessionId)?.running ?? 0)
    + s.recoveries.filter((item) => item.record.session === sessionId).length,
  );
  const selectionMode = Boolean(binding) && !isSearching && (selectingDownloads || selectedDownloads.size > 0);
  const mutationRequestIsCurrent = !mutationRequest || !!binding
    && mutationRequest.binding.logicalSessionId === binding.logicalSessionId
    && mutationRequest.binding.physicalPtyId === binding.physicalPtyId
    && mutationRequest.binding.transportGeneration === binding.transportGeneration;
  useEffect(() => {
    if (mutationRequest && !mutationRequestIsCurrent) setMutationRequest(null);
  }, [mutationRequest, mutationRequestIsCurrent]);

  const queueLocalPaths = useCallback(async (paths: string[], destinationRoot: string) => {
    if (!binding || paths.length === 0 || treeRequestContextRef.current !== treeRequestContext) return false;
    const result = await queueLocalTransferPaths({ binding, remoteHost, paths, destinationRoot, t });
    if (result.status === "prepareFailed") {
      setDropMessage(t("explorer.mutation.prepare_failed"));
      return false;
    }
    setDropMessage(t("explorer.drop.queued", { files: result.files, directories: result.directories }));
    return true;
  }, [binding, remoteHost, t, treeRequestContext]);

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
      const listRect = treeListRef.current?.getBoundingClientRect();
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
          scrollTop: treeListRef.current?.scrollTop ?? 0,
          inset: LISTING_TOP_INSET,
          rowHeight: LISTING_ROW_HEIGHT,
          nodes: listing.nodes,
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
          useUIStore.getState().addToast(errorToast({
            sessionId,
            title: t("explorer.drop.failed"),
            next: t("explorer.upload.failed_hint"),
            error,
          }));
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
        useUIStore.getState().addToast(errorToast({ sessionId, title: t("explorer.upload.failed"), next: t("explorer.upload.failed_hint") }));
        return;
      }
      const paths = selected === null ? [] : Array.isArray(selected) ? selected : [selected];
      try {
        await queueLocalPaths(paths, directory);
      } catch {
        useUIStore.getState().addToast(errorToast({ sessionId, title: t("explorer.drop.failed"), next: t("explorer.mutation.prepare_failed") }));
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
        useUIStore.getState().addToast(errorToast({ sessionId, title: t("explorer.drop.failed"), next: t("explorer.mutation.prepare_failed") }));
      }
    }
  };

  const openEditor = (path: string, line?: number) => {
    void openInEditorWithToast(externalEditor, path, { line });
  };

  // Resolve the starting directory. Local: workspace rootDir. Remote: `/`
  // is the listing root; OSC 7 or SFTP home is only the first location.
  const initializedDirectory = useRef<string | null>(null);
  const homeResolvedForBinding = useRef<string | null>(null);
  useEffect(() => {
    const directorySource = JSON.stringify([sessionId, isRemote, remotePtyId, transportGeneration]);
    const sourceChanged = initializedDirectory.current !== directorySource;
    if (sourceChanged) {
      initializedDirectory.current = directorySource;
      setNavDir(null);
      search.resetSearch();
    }
    if (isRemote) {
      const listingRoot = remoteExplorerListingRoot();
      setBaseDir(listingRoot);
      const knownStart = useUIStore.getState().explorerPaths[sessionId] ?? knownRemoteExplorerRoot(rootDir);
      if (knownStart) setCurrentPath((current) => current || knownStart);
      if (remoteDisconnected) {
        setCurrentPath((current) => current || knownStart || listingRoot);
        setLoading(false);
        return;
      }
      if (remotePtyId === undefined || homeResolvedForBinding.current === directorySource) return;
      if (!knownStart) setLoading(true);
      let cancelled = false;
      sshHome(remotePtyId)
        .then((home) => {
          if (!cancelled) {
            homeResolvedForBinding.current = directorySource;
            setHomeDir(home);
            setCurrentPath((current) => current || home);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setHomeDir(null);
            setCurrentPath((current) => current || listingRoot);
          }
        });
      return () => { cancelled = true; };
    }
    if (!sourceChanged) return;
    setHomeDir(null);
    setBaseDir(rootDir);
    setCurrentPath(useUIStore.getState().explorerPaths[sessionId] ?? rootDir);
    // Follow-cwd applies later OSC 7 updates. Including rootDir here would
    // clear search and reset local/remote explorers on every shell cd.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see above
  }, [isRemote, remotePtyId, remoteDisconnected, sessionId, transportGeneration]);

  useEffect(() => {
    // Initialization already chose the remembered directory. Only subsequent
    // cwd/follow changes should move an explorer that the user has navigated.
    const previous = previousCwdFollow.current;
    previousCwdFollow.current = { rootDir, followTerminalCwd };
    if (previous.rootDir === rootDir && previous.followTerminalCwd === followTerminalCwd) return;
    if (!isRemote || !followTerminalCwd || remoteDisconnected) return;
    const knownStart = knownRemoteExplorerRoot(rootDir);
    if (!knownStart) return;
    setCurrentPath(knownStart);
  }, [rootDir, isRemote, followTerminalCwd, remoteDisconnected, setCurrentPath]);

  useEffect(() => {
    if (!prefsKey || !currentPath.startsWith("/")) return;
    useSessionsStore.getState().patchHostFilePrefs(prefsKey, (prefs) => pushHostRecentPath(prefs, currentPath));
  }, [prefsKey, currentPath]);

  const browsingContext = useMemo(() => ({ baseDir, currentPath, includeHidden, reloadKey, sessionId, isRemote }), [baseDir, currentPath, includeHidden, reloadKey, sessionId, isRemote]);
  const listingContext = useMemo(() => ({ treeRequestContext, browsingContext }), [treeRequestContext, browsingContext]);
  const loadedListingContext = useRef<typeof listingContext | null>(null);
  const lastUploadReloadKey = useRef(uploadReloadKey);
  useEffect(() => {
    const backgroundRefresh = loadedListingContext.current === listingContext;
    const reopened = backgroundRefresh && lastUploadReloadKey.current === uploadReloadKey;
    lastUploadReloadKey.current = uploadReloadKey;
    const reconnected = isRemote && !remoteDisconnected && !backgroundRefresh
      && loadedListingContext.current?.browsingContext === browsingContext;
    if (baseDir === null) return;
    if (!isRemote && !currentPath.startsWith("/")) {
      // A fresh local session reports `~` until OSC 7 arrives. Resolve it to
      // the real home so breadcrumbs/parents work; Refresh retries on failure.
      let cancelled = false;
      setLoading(true);
      setError(false);
      fsResolveDir(currentPath)
        .then((absolute) => {
          if (cancelled) return;
          setBaseDir((current) => (current?.startsWith("/") ? current : absolute));
          if (currentPath === "~") setLocalHomeDir(absolute);
          setCurrentPath(absolute);
        })
        .catch(() => {
          if (cancelled) return;
          setEntries([]);
          setCachedListingKey(null);
          setError(true);
          setLoading(false);
        });
      return () => { cancelled = true; };
    }
    if (!currentPath.startsWith("/")) return;
    if (remoteDisconnected) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    if (!backgroundRefresh && !reconnected) {
      setLoading(true);
      setError(false);
    }
    const read =
      isRemote && remotePtyId !== undefined
        ? sshReadDir(remotePtyId, currentPath, includeHidden)
        : fsReadDir(currentPath, includeHidden);
    read
      .then((e) => {
        if (!cancelled && treeRequestContextRef.current === treeRequestContext) {
          setEntries(e);
          setCachedListingKey(listingCacheKey);
          loadedListingContext.current = listingContext;
          setError(false);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled && treeRequestContextRef.current === treeRequestContext && (!backgroundRefresh || reopened)) {
          setEntries([]);
          setCachedListingKey(null);
          setError(true);
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [currentPath, includeHidden, treeRequestContext, browsingContext, listingContext, listingCacheKey, uploadReloadKey, baseDir, isRemote, remotePtyId, remoteDisconnected, setCurrentPath]);

  const breadcrumbRoot = remoteExplorerListingRoot();
  const dropListingNodes = useMemo<DropListingNode[]>(() => listingNodes.map(({ path, entry }) => ({
    path, parentPath: null, kind: entry.kind,
  })), [listingNodes]);
  listingDropRef.current = { currentPath, nodes: dropListingNodes };
  const selectableDownloadNodes = useMemo(() => binding
    ? listingNodes.filter((node) => node.entry.kind === "file" && node.entry.size <= downloadLimits.maxFileBytes)
    : [], [binding, listingNodes, downloadLimits]);

  const contentKey = isSearching ? `search:${searchMode}:${searchQuery}` : currentPath;
  const hasCachedRemoteListing = remoteDisconnected && hasCachedListing;
  const listingRowCount = listingNodes.length;
  const { view: listScroll, measure: measureTree } = useExplorerViewport(treeListRef, contentKey);
  const virtualizeListing = !isSearching && listingRowCount > 100;
  const listingSlice = virtualizeListing
    ? computeVirtualSlice(
        listingRowCount,
        Math.max(0, listScroll.top - LISTING_TOP_INSET),
        listScroll.height,
        LISTING_ROW_HEIGHT,
      )
    : { first: 0, last: listingRowCount, topPad: 0, bottomPad: 0 };
  const focusedPath = focusedPathRef.current;
  const rovingFocusPath = focusedPath && nodeIndexByPath.has(focusedPath)
    ? focusedPath
    : listingNodes[Math.max(0, Math.min(listingFocusIndex, listingRowCount - 1))]?.path;
  const mountedTreeIndexes = virtualizeListing
    ? mountedTreeRowIndexes(listingRowCount, listingSlice, [
        nodeIndexByPath.get(rovingFocusPath ?? "") ?? -1,
        nodeIndexByPath.get(dropHighlightPath ?? "") ?? -1,
        nodeIndexByPath.get(menuReturnPath ?? "") ?? -1,
      ])
    : Array.from({ length: listingRowCount }, (_, index) => index);
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

  useLayoutEffect(() => {
    if (focusAfterNavigationRef.current !== currentPath || loading || (!hasCachedListing && !error)) return;
    focusAfterNavigationRef.current = null;
    if (active && document.activeElement === document.body) {
      const listing = treeListRef.current;
      const target = listing?.querySelector<HTMLElement>("[data-explorer-item], [role=alert] button") ?? listing;
      target?.focus({ preventScroll: true });
    }
  }, [active, currentPath, error, hasCachedListing, loading]);

  useLayoutEffect(() => {
    if (pendingListingFocus === null) return;
    const target = treeListRef.current?.querySelector<HTMLElement>(
      `[data-listing-index="${pendingListingFocus}"]`,
    );
    if (!target) return;
    target.focus({ preventScroll: true });
    setPendingListingFocus(null);
  }, [listingSlice.first, listingSlice.last, pendingListingFocus, rovingFocusPath]);

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

  function prepareNavigation(path: string, direction: "in" | "out", focusListing: boolean) {
    if (remoteDisconnected) return false;
    search.setQuery("");
    if (path === currentPath) return false;
    focusAfterNavigationRef.current = focusListing ? path : null;
    focusedPathRef.current = null;
    setListingFocusIndex(0);
    setPendingListingFocus(null);
    setNavDir(direction);
    return true;
  }

  function navigateTo(path: string, direction: "in" | "out" = "in", focusListing = false) {
    if (prepareNavigation(path, direction, focusListing)) setCurrentPath(path);
  }

  function goHistory(offset: -1 | 1) {
    const path = history?.paths[history.index + offset];
    if (path && prepareNavigation(path, offset === -1 ? "out" : "in", false)) {
      useUIStore.getState().stepExplorerHistory(sessionId, offset);
    }
  }

  function focusTreeIndex(index: number) {
    const target = Math.max(0, Math.min(index, listingNodes.length - 1));
    const node = listingNodes[target];
    if (!node) return;
    focusedPathRef.current = node.path;
    setListingFocusIndex(target);
    const list = treeListRef.current;
    const mounted = list?.querySelector<HTMLElement>(`[data-listing-index="${target}"]`);
    if (mounted) {
      mounted.focus();
      return;
    }
    if (!list) return;
    const rowTop = LISTING_TOP_INSET + target * LISTING_ROW_HEIGHT;
    list.scrollTop = Math.max(0, rowTop - Math.max(0, list.clientHeight - LISTING_ROW_HEIGHT));
    measureTree();
    setPendingListingFocus(target);
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

  async function prepareDelete(node: ListingNode) {
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
      setMutationPrepareError(`${t("explorer.mutation.prepare_failed")}: ${String(error)}`);
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
        const destinationPath = joinPath(currentPath, name);
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
      setMutationComposer((current) => current
        ? { ...current, error: `${t("explorer.mutation.prepare_failed")}: ${String(error)}` }
        : current);
    } finally {
      setMutationBusy(false);
    }
  }

  function treeMenuItems(node: ListingNode): MenuEntry[] {
    const isDir = node.entry.kind === "dir";
    if (isDir) {
      return isRemote
        ? [
            { id: "dir:mkdir", label: t("explorer.mutation.mkdir"), icon: "folder", action: () => { suppressMenuFocusRef.current = true; setMutationComposer({ kind: "mkdir", node, value: "", bindingKey: treeRequestContext, error: undefined }); } },
            { id: "dir:new-file", label: t("explorer.capability.new_file_unavailable"), icon: "editor", disabled: true, action: () => {} },
            { id: "dir:download", label: t("explorer.download_folder"), icon: "download", disabled: remoteDisconnected || !binding, action: () => { void downloadRemoteFolder(node.path, node.entry.name); } },
            { id: "dir:rename", label: t("explorer.mutation.rename"), icon: "rename", action: () => { suppressMenuFocusRef.current = true; setMutationComposer({ kind: "rename", node, value: node.entry.name, bindingKey: treeRequestContext, error: undefined }); } },
            { id: "dir:delete", label: t("explorer.mutation.delete"), icon: "close", danger: true, action: () => { suppressMenuFocusRef.current = true; void prepareDelete(node); } },
            { id: "dir:metadata", label: t("explorer.properties"), icon: "search", action: () => { suppressMenuFocusRef.current = true; setProperties({ path: node.path, bindingKey: treeRequestContext }); } },
            { id: "dir:copy-path", label: t("sidebar.dir.copy_path"), icon: "copy", action: () => { void copyPathWithFeedback(node.path); } },
          ]
        : [
            { id: "dir:new-terminal", label: t("common.new_terminal_here"), icon: "terminal", action: () => useSessionsStore.getState().newTerminalInDir(node.path) },
            { id: "dir:open-editor", label: t("sidebar.dir.open_in_editor"), icon: "editor", action: () => openEditor(node.path) },
            { id: "dir:copy-path", label: t("sidebar.dir.copy_path"), icon: "copy", action: () => { void copyPathWithFeedback(node.path); } },
          ];
    }
    return isRemote
      ? [
          { id: "file:open-tunara", label: t("explorer.open_in_tunara"), icon: "editor", action: () => openFile(node.path) },
          { id: "file:open-editor", label: t("preview.editor.external_remote"), icon: "editor", disabled: remoteDisconnected || !binding, action: () => {
            if (!binding) return;
            void openRemoteInExternalEditor({ sessionId, binding, remotePath: node.path, editor: externalEditor }).catch((error: unknown) => {
              useUIStore.getState().addToast(errorToast({
                sessionId,
                title: t("preview.editor.external_remote"),
                next: t("preview.editor.external_remote_open_failed"),
                error,
              }));
            });
          } },
          { id: "file:rename", label: t("explorer.mutation.rename"), icon: "rename", action: () => { suppressMenuFocusRef.current = true; setMutationComposer({ kind: "rename", node, value: node.entry.name, bindingKey: treeRequestContext, error: undefined }); } },
          { id: "file:delete", label: t("explorer.mutation.delete"), icon: "close", danger: true, action: () => { suppressMenuFocusRef.current = true; void prepareDelete(node); } },
          { id: "file:metadata", label: t("explorer.properties"), icon: "search", action: () => { suppressMenuFocusRef.current = true; setProperties({ path: node.path, bindingKey: treeRequestContext }); } },
          { id: "file:open-terminal", label: t("explorer.open_in_terminal"), icon: "terminal", action: () => useSessionsStore.getState().openFileInTerminal(sessionId, currentPath, node.entry.name) },
          { id: "file:download", label: node.entry.size > downloadLimits.maxFileBytes ? t("explorer.download.too_large", { limit: formatSize(downloadLimits.maxFileBytes) }) : t("explorer.download"), icon: "download", disabled: node.entry.size > downloadLimits.maxFileBytes || !binding || !!downloadChooserPendingRef.current, action: () => { void downloadRemoteFile(node.path, node.entry.name); } },
          { id: "file:copy-path", label: t("sidebar.dir.copy_path"), icon: "copy", action: () => { void copyPathWithFeedback(node.path); } },
        ]
      : [
          { id: "file:open-tunara", label: t("explorer.open_in_tunara"), icon: "editor", action: () => openFile(node.path) },
          { id: "file:open-terminal", label: t("explorer.open_in_terminal"), icon: "terminal", action: () => useSessionsStore.getState().openFileInTerminal(sessionId, currentPath, node.entry.name) },
          { id: "file:open-vscode", label: t("explorer.open_in_vscode"), icon: "editor", action: () => { void openInEditorWithToast("vscode", node.path, { sessionId }); } },
          ...(externalEditor === "vscode" ? [] : [{ id: "file:open-editor", label: t("sidebar.dir.open_in_editor"), icon: "editor" as const, action: () => openEditor(node.path) }]),
          { id: "file:copy-path", label: t("sidebar.dir.copy_path"), icon: "copy", action: () => { void copyPathWithFeedback(node.path); } },
        ];
  }

  function toggleDownloadSelection(node: ListingNode, range: boolean) {
    if (!binding || node.entry.kind !== "file" || node.entry.size > downloadLimits.maxFileBytes) return;
    const nextSource = { path: node.path, name: node.entry.name, size: node.entry.size };
    let rejected: "files" | "total" | null = null;
    const next = new Map(selectedDownloads);
    let totalBytes = [...next.values()].reduce((total, source) => total + source.size, 0);
    if (range && selectionAnchorRef.current) {
      const anchor = selectableDownloadNodes.findIndex(({ path }) => path === selectionAnchorRef.current);
      const target = selectableDownloadNodes.findIndex(({ path }) => path === node.path);
      if (anchor >= 0 && target >= 0) {
        for (const candidate of selectableDownloadNodes.slice(Math.min(anchor, target), Math.max(anchor, target) + 1)) {
          if (next.has(candidate.path)) continue;
          if (next.size >= downloadLimits.maxFiles) { rejected = "files"; break; }
          if (totalBytes + candidate.entry.size > downloadLimits.maxTotalBytes) { rejected = "total"; break; }
          next.set(candidate.path, { path: candidate.path, name: candidate.entry.name, size: candidate.entry.size });
          totalBytes += candidate.entry.size;
        }
      }
    } else if (next.has(node.path)) {
      next.delete(node.path);
    } else if (next.size >= downloadLimits.maxFiles) {
      rejected = "files";
    } else if (totalBytes + node.entry.size > downloadLimits.maxTotalBytes) {
      rejected = "total";
    } else {
      next.set(node.path, nextSource);
    }
    setSelectedDownloads(next);
    if (rejected) showSelectionLimit(rejected);
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
    let rejected: "files" | "total" | null = null;
    for (const node of selectableDownloadNodes) {
      if (next.size >= downloadLimits.maxFiles) { rejected = "files"; break; }
      if (total + node.entry.size > downloadLimits.maxTotalBytes) { rejected = "total"; break; }
      next.set(node.path, { path: node.path, name: node.entry.name, size: node.entry.size });
      total += node.entry.size;
    }
    setSelectedDownloads(next);
    if (rejected) showSelectionLimit(rejected);
  }

  function showSelectionLimit(kind: "files" | "total") {
    useUIStore.getState().addToast({
      sessionId,
      title: t("explorer.download.selection_limit_title"),
      subtitle: kind === "files"
        ? t("explorer.download.selection_file_limit", { limit: downloadLimits.maxFiles })
        : t("explorer.download.selection_size_limit", { limit: formatSize(downloadLimits.maxTotalBytes) }),
      variant: "warning",
    });
  }

  async function downloadSelectedFiles() {
    if (!binding || !hasCachedListing || selectedDownloads.size === 0 || batchDownloadPreparing) return;
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
      const isMissing = downloadListingRef.current;
      if (treeRequestContextRef.current !== requestContext || !isMissing) return;
      const sources = [...selectedDownloads.values()].filter(({ path }) => !isMissing(path));
      if (sources.length === 0) return;
      const requests = planBatchDownloads({
        sources,
        destinationRoot,
        existingNames: existing.map(({ name }) => name),
        binding,
        limits: downloadLimits,
      });
      useTransferStore.getState().enqueueBatch(requests);
      exitDownloadSelection();
    } catch {
      if (treeRequestContextRef.current === requestContext) {
        useUIStore.getState().addToast(errorToast({
          sessionId,
          title: t("explorer.download.failed"),
          next: t("explorer.download.batch_prepare_failed"),
        }));
      }
    } finally {
      if (treeRequestContextRef.current === requestContext) setBatchDownloadPreparing(false);
    }
  }

  function exitDownloadSelection() {
    setSelectingDownloads(false);
    setSelectedDownloads(new Map());
    selectionAnchorRef.current = null;
  }

  function renderListingRow(node: ListingNode, listingIndex: number) {
    const isDir = node.entry.kind === "dir";
    const active = activeFilePath === node.path;
    const batchSelectable = !!binding && node.entry.kind === "file" && node.entry.size <= downloadLimits.maxFileBytes;
    const batchSelected = selectedDownloads.has(node.path);
    const openMenu = (x: number, y: number, opener: HTMLElement) => {
      if (remoteDisconnected) return;
      menuReturnPathRef.current = node.path;
      setMenuReturnPath(node.path);
      menuReturnFocusRef.current = opener;
      setContextMenu({ position: { x, y }, items: treeMenuItems(node), bindingKey: treeRequestContext });
    };
    return (
      <div
        key={node.path}
        role="treeitem"
        aria-label={node.entry.name}
        aria-setsize={listingRowCount}
        aria-posinset={listingIndex + 1}
        aria-selected={batchSelectable ? batchSelected : batchSelected || active}
        data-explorer-item
        data-listing-index={listingIndex}
        data-tree-row-index={listingIndex}
        data-tree-path={node.path}
        data-drop-target={dropHighlightPath === node.path ? "true" : undefined}
        data-file-path={!isDir ? node.path : undefined}
        tabIndex={rovingFocusPath === node.path ? 0 : -1}
        onFocus={(event) => {
          if (event.target !== event.currentTarget) return;
          focusedPathRef.current = node.path;
          setListingFocusIndex(listingIndex);
        }}
        onClick={(event) => {
          const target = event.target as HTMLElement;
          if (target.closest("button, input")) return;
          if (batchSelectable && (event.ctrlKey || event.metaKey || event.shiftKey)) {
            toggleDownloadSelection(node, event.shiftKey);
            return;
          }
          if (isDir) navigateTo(node.path, "in", true);
          else openFile(node.path);
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
          if (event.key === "Enter" || (event.key === "ArrowRight" && isDir)) {
            event.preventDefault(); event.stopPropagation();
            if (remoteDisconnected) return;
            if (isDir) navigateTo(node.path, "in", true);
            else openFile(node.path);
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
              : event.key === "End" ? listingNodes.length - 1
                : listingIndex + (event.key === "ArrowDown" ? 1 : -1);
            focusTreeIndex(target);
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
            for (let offset = 1; offset <= listingNodes.length; offset += 1) {
              const index = (listingIndex + offset) % listingNodes.length;
              if (listingNodes[index].entry.name.toLocaleLowerCase().startsWith(query)) { focusTreeIndex(index); break; }
            }
          }
        }}
        className="explorer-tree-node"
        style={{
          height: LISTING_ROW_HEIGHT,
          transform: virtualizeListing ? `translateY(${listingIndex * LISTING_ROW_HEIGHT}px)` : undefined,
        }}
      >
        <div
          className="hover-bg explorer-listing-grid explorer-listing-row"
          data-selectable={selectionMode ? "true" : undefined}
          data-active={batchSelected || active}
        >
        {selectionMode && (
          <input
            type="checkbox"
            tabIndex={-1}
            className="ui-choice"
            aria-label={node.entry.kind === "file" ? t("explorer.download.select_file", { file: node.entry.name }) : undefined}
            checked={batchSelected}
            disabled={!batchSelectable}
            title={node.entry.kind === "file" && node.entry.size > downloadLimits.maxFileBytes ? t("explorer.download.too_large") : undefined}
            onClick={(event) => { event.stopPropagation(); toggleDownloadSelection(node, event.shiftKey); }}
            onChange={() => {}}
            style={{ visibility: node.entry.kind === "file" ? "visible" : "hidden" }}
          />
        )}
        <span className="explorer-listing-name">
          <span aria-hidden="true" className="explorer-entry-icon">
            {isDir ? <FolderIcon /> : <FileIcon tint={fileKindTint(node.entry.name)} />}
          </span>
          <ExplorerEntryName name={node.entry.name} />
        </span>
        <span className="explorer-listing-modified">{formatModifiedTime(node.entry.mtime)}</span>
        {!remoteDisconnected && <button
          type="button"
          tabIndex={-1}
          className="hover-bg explorer-listing-action"
          aria-label={`${t("common.more_actions")}: ${node.entry.name}`}
          title={t("common.more_actions")}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            openMenu(rect.right, rect.bottom, event.currentTarget);
          }}
        >
          <Icon icon={DotsThree} size={14} weight="bold" />
        </button>}
        </div>
      </div>
    );
  }


  function openFile(path: string, line?: number) {
    if (remoteDisconnected) return;
    const owner = useSessionsStore.getState().sessions.find((session) => session.id === sessionId);
    if (!owner) return;
    void openResource(resourceRefForSession(owner, path, line), "preview");
  }

  function changeSort(key: SortKey) {
    setSort((current) => current.key === key
      ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
      : { key, direction: key === "modified" ? "desc" : "asc" });
  }

  function renderSearchRow(row: SearchRow) {
    if (row.kind === "line") {
      const { group, ln } = row;
      return (
        <button
          data-explorer-item
          onClick={() => openFile(group.path, ln.line)}
          title={group.rel}
          className="hover-bg explorer-search-hit explorer-search-line"
          style={{ height: GREP_LINE_HEIGHT - 1 }}
        >
          <span className="explorer-search-line-number">{ln.line}</span>
          <span className="explorer-search-line-text">{ln.text}</span>
        </button>
      );
    }
    const file = row.kind === "name" ? row.hit : row.group;
    const isDir = row.kind === "name" && row.hit.isDir;
    const pathLabel = (
      <>
        {isDir ? <FolderIcon /> : <FileIcon tint={fileKindTint(row.kind === "name" ? row.hit.name : file.rel)} />}
        <span className="explorer-search-path" title={file.rel}>{compactRelativePath(file.rel)}</span>
      </>
    );
    if (row.kind === "group") {
      return (
        <div className="explorer-search-group" style={{ height: GREP_HEADER_HEIGHT }}>
          {pathLabel}
          <span className="explorer-search-count">{row.group.lines.length}</span>
        </div>
      );
    }
    return (
      <button
        data-explorer-item
        data-active={activeFilePath === file.path}
        onClick={() => isDir ? navigateTo(file.path) : openFile(file.path)}
        className="hover-bg explorer-search-hit"
        style={{ height: LISTING_ROW_HEIGHT - 2 }}
      >
        {pathLabel}
        {isDir && <TreeChevron />}
      </button>
    );
  }

  const resultCount = searchMode === "content" ? grepHits.length : searchHits.length;
  const resultsTruncated = searchMode === "content" ? grepTruncated : searchTruncated;
  const searchHeader = searchLoading && resultCount === 0 ? (
    <PanelLoadingState label={t("explorer.searching")} />
  ) : searchError ? (
    <>
      <PanelEmptyState label={t("explorer.search_failed")} sublabel={searchQuery.trim()} />
      <div className="explorer-search-retry">
        <button className="hover-bg" onClick={search.retrySearch}>{t("common.retry")}</button>
      </div>
    </>
  ) : (
    <>
      {resultCount === 0 ? (
        <PanelEmptyState label={t(searchMode === "content" ? "explorer.content_no_match" : "explorer.no_match")} sublabel={searchQuery.trim()} />
      ) : (
        <div className="explorer-search-summary">
          <span>{t("explorer.results")}</span>
          <span className="explorer-search-count">{resultCount}</span>
        </div>
      )}
      {searchUnreadable !== 0 && (
        <div role="status" className="explorer-search-unreadable">
          {t(searchUnreadable === 1 ? "explorer.search_unreadable_one" : "explorer.search_unreadable_other", { count: searchUnreadable })}
        </div>
      )}
    </>
  );

  return (
    <div
      ref={explorerRef}
      className="file-explorer"
      onDragEnter={(event) => { event.preventDefault(); if (binding) setDropActive(true); }}
      onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false); }}
      onDrop={(event) => { event.preventDefault(); setDropActive(false); }}
      data-drop-active={dropActive}
    >
      {dropActive && (
        <div role="status" className="explorer-drop-notice">
          ↥ {dropHighlightPath ? t("explorer.drop.on_folder", { path: dropHighlightPath }) : t("explorer.drop.ready")}
        </div>
      )}
      {dropMessage && <div role="status" aria-live="polite" className="sr-only">{dropMessage}</div>}
      {mutationPrepareError && (
        <div role="alert" className="explorer-error-notice">
          {mutationPrepareError}
        </div>
      )}
      <ExplorerNav
        t={t}
        disabled={remoteDisconnected}
        canGoBack={!!history && history.index > 0}
        canGoForward={!!history && history.index + 1 < history.paths.length}
        onGoBack={() => goHistory(-1)}
        onGoForward={() => goHistory(1)}
        currentPath={currentPath}
        breadcrumbRoot={breadcrumbRoot}
        breadcrumbHome={isRemote ? homeDir : localHomeDir}
        onNavigate={navigateTo}
        onRefresh={refresh}
      />
      <ExplorerSearchRow
        t={t}
        disabled={remoteDisconnected}
        searchMode={searchMode}
        searchQuery={searchQuery}
        onToggleSearchMode={search.toggleSearchMode}
        onQueryChange={(query) => {
          if (selectionMode && query.trim()) exitDownloadSelection();
          search.setQuery(query);
        }}
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
          if (isSearching) {
            if (focusFirstSearchResultRef.current?.()) event.preventDefault();
            return;
          }
          const first = treeListRef.current?.querySelector<HTMLElement>("[data-explorer-item]");
          if (!first) return;
          event.preventDefault();
          first.focus();
        }}
      />
      {isRemote && includeHidden && isSearching && (
        <div role="status" aria-live="polite" className="explorer-search-notice">
          {t("explorer.remote_hidden_search_notice")}
        </div>
      )}
      {isRemote && (
        <ExplorerRemoteTools
          t={t}
          active={active}
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
          favoritePaths={hostPrefs.favoritePaths}
          recentPaths={hostPrefs.recentPaths}
          onJumpToPath={navigateTo}
          remoteDisconnected={remoteDisconnected}
          uploadBusy={upload !== null}
          onUploadFile={() => { void uploadToRemoteDirectory(currentPath); }}
          showFolderTransfer={Boolean(binding)}
          onUploadFolder={() => { void uploadFolderToRemoteDirectory(currentPath); }}
          selectionMode={selectionMode}
          downloadSelectionUnavailable={isSearching}
          onToggleSelectionMode={() => {
            if (selectionMode) exitDownloadSelection();
            else setSelectingDownloads(true);
          }}
          selectedDownloadCount={binding && hasCachedListing ? selectedDownloads.size : 0}
          batchDownloadPreparing={batchDownloadPreparing}
          onDownloadSelected={() => { void downloadSelectedFiles(); }}
          activeTransferNotice={activeTransferNotice}
          onOpenTransfers={() => {
            useUIStore.getState().setPanelVisible(true);
            useUIStore.getState().setInspectorTab("transfers", { sessionId });
          }}
        />
      )}
      {hasCachedRemoteListing && (
        <div role="status" title={t("explorer.remote_disconnected")} className="explorer-disconnected">
          {t("explorer.remote_disconnected")}
        </div>
      )}

      {upload && (
        <div className="explorer-transfer-status">
          <div className="explorer-transfer-row">
            <span>
              {upload.cancelling ? t("explorer.upload.cancelling") : t("explorer.upload.progress", { file: upload.fileName, percent: upload.total > 0 ? Math.min(100, Math.round(upload.transferred / upload.total * 100)) : 0 })}
            </span>
            <button type="button" onClick={directUpload.cancelUpload} disabled={upload.cancelling} className="hover-bg">{t("common.cancel")}</button>
          </div>
          <progress className="ui-progress" aria-label={t("explorer.upload.progress_label")} max={upload.total || 1} value={upload.transferred} />
        </div>
      )}
      <div aria-live="polite" aria-atomic="true" className="sr-only" data-transfer-announcement>
        {transferAnnouncement}
      </div>
      {isSearching && (
        <SearchViewport
          key={contentKey}
          ref={focusFirstSearchResultRef}
          rows={searchError ? [] : searchRows}
          renderRow={renderSearchRow}
          header={searchHeader}
          footer={resultCount > 0 && !searchError && (resultsTruncated || searchLoading) && (
            searchLoading || searchLimit >= searchMaxLimit ? (
              <div className="explorer-search-limit" aria-live={searchLoading ? "polite" : undefined}>
                {t(searchLoading ? "explorer.searching" : "explorer.results_limit_reached")}
              </div>
            ) : (
              <button type="button" className="hover-bg explorer-search-more" onClick={search.loadMoreSearchResults}>
                {t("explorer.load_more")}
              </button>
            )
          )}
        />
      )}
      {!isSearching && <div
        key={contentKey}
        ref={treeListRef}
        tabIndex={-1}
        onScroll={measureTree}
        data-nav={navDir}
        className="no-scrollbar scroll-fade-y"
      >
        {remoteDisconnected && !hasCachedRemoteListing ? (
          <div className="explorer-state-shell">
            <PanelEmptyState
              label={t("explorer.remote_unavailable")}
              sublabel={t("explorer.remote_unavailable_hint")}
              compact={false}
            />
          </div>
        ) : (loading || (!hasCachedListing && !error)) && !hasCachedRemoteListing ? (
          <div className="explorer-state-shell"><PanelLoadingState label={t("explorer.loading")} /></div>
        ) : error && !hasCachedRemoteListing ? (
          <div className="explorer-state-shell">
            <PanelState state={{
              kind: "error",
              label: t("explorer.read_dir_failed"),
              detail: currentPath,
              retryLabel: t("common.retry"),
              onRetry: refresh,
            }} />
          </div>
        ) : listingRowCount === 0 ? (
          <div className="explorer-state-shell">
            <PanelEmptyState icon={folderEmptyIcon} label={t("explorer.dir_empty")} compact={false} />
          </div>
        ) : (
          <>
            <div
              className="explorer-listing-grid explorer-listing-header"
              data-selectable={selectionMode ? "true" : undefined}
            >
              {selectionMode && (
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
                  <div key={key} className={key === "modified" ? "explorer-listing-modified" : undefined}>
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
              <span className="explorer-listing-action" aria-hidden="true" />
            </div>
            <div
              role="tree"
              aria-label={t("explorer.file_list")}
              aria-multiselectable={binding ? "true" : undefined}
              data-tree-row-count={listingRowCount}
              data-tree-mounted-count={mountedTreeIndexes.length}
              data-virtual={virtualizeListing}
              style={virtualizeListing ? { height: listingRowCount * LISTING_ROW_HEIGHT } : undefined}
            >
              {mountedTreeIndexes.map((index) => renderListingRow(listingNodes[index], index))}
            </div>
          </>
        )}
      </div>}

      {active && properties?.bindingKey === treeRequestContext && binding && (
        <Modal
          labelledBy="remote-metadata-title"
          onRequestClose={() => setProperties(null)}
          bindingKey={properties.bindingKey}
          currentBindingKey={treeRequestContext}
          style={{ width: 480 }}
        >
          <RemoteMetadataPanel binding={binding} path={properties.path} host={remoteHost ?? sessionId} />
          <div className="explorer-metadata-footer">
            <button type="button" className="ui-button" onClick={() => setProperties(null)}>{t("common.close")}</button>
          </div>
        </Modal>
      )}

      {active && mutationComposer && !remoteDisconnected && (
        <>
          <div aria-hidden="true" className="explorer-mutation-backdrop" />
          <div
            ref={mutationComposerRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="remote-mutation-name-title"
            className="explorer-mutation-dialog"
          >
            <strong id="remote-mutation-name-title">{t(`explorer.mutation.${mutationComposer.kind}`)}</strong>
            <label>
              {t("explorer.mutation.name")}
              <input
                className="ui-control"
                autoFocus
                value={mutationComposer.value}
                onChange={(event) => setMutationComposer((current) => current ? { ...current, value: event.target.value, error: undefined } : current)}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                  if (event.key === "Enter") { event.preventDefault(); void prepareNamedMutation(); }
                }}
              />
            </label>
            {mutationComposer.error && (
              <p role="alert">
                {mutationComposer.error}
              </p>
            )}
            <div className="explorer-mutation-footer">
              <button type="button" className="ui-button" onClick={() => { setMutationComposer(null); restoreMenuFocus(); }} disabled={mutationBusy}>{t("common.cancel")}</button>
              <button type="button" className="ui-button ui-button--primary" onClick={() => { void prepareNamedMutation(); }} disabled={mutationBusy || !mutationComposer.value.trim()}>{t("common.continue")}</button>
            </div>
          </div>
        </>
      )}

      {active && mutationRequest && mutationRequestIsCurrent && (
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

      {active && contextMenu && !remoteDisconnected && (
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
