import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { computeVirtualSlice } from "./lib/diff-virtual";

/** 目录行距：30px 按钮 + 2px marginBottom，恒定值（展开态只改底色不改高度）。 */
const LISTING_ROW_HEIGHT = 32;
/** 滚动容器上内边距 6px + 表头 24px + 表头下边距 3px。 */
const LISTING_TOP_INSET = 33;
const MAX_REMOTE_DOWNLOAD_BYTES = 100 * 1024 * 1024;
import { confirm as confirmDialog, open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  fsCancelActiveNameSearch,
  fsCancelGrep,
  fsGrep,
  fsReadDir,
  fsSearch,
  type DirEntry,
  type GrepResponse,
  type SearchHit,
} from "@/modules/fs/fs-bridge";
import {
  cancelRemoteSearch,
  invalidateRemoteSearchCache,
  sshDownload,
  sshCancelUpload,
  sshGrep,
  sshHome,
  sshReadDir,
  sshSearch,
  sshUpload,
} from "@/modules/ssh/remote-fs-bridge";
import { formatSize } from "./types";
import { CloseIcon, RefreshIcon, SearchIcon, PanelEmptyState, PanelLoadingState } from "./shared";
import { ContextMenu, type MenuEntry } from "./ContextMenu";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { openResource, resourceRefForSession } from "@/modules/resources/resource-ref";
import { openInEditorWithToast } from "./lib/open-in-editor";
import { useT, t as staticT } from "@/modules/i18n";
import { breadcrumbSegments } from "./lib/breadcrumbs";
import { copyText } from "./lib/clipboard";
import { groupGrepHitsByFile, type GrepFileGroup } from "@/modules/fs/lib/grep-group";
import { knownRemoteExplorerRoot } from "./lib/file-explorer-root";
import { FileSearchGeneration } from "./lib/file-search-session";
import { classifyTransferDrop, expandFolderTransfer, renamedSibling } from "@/modules/ssh/transfer-intent";
import { validateManifest } from "@/modules/ssh/transfer-bridge";
import { useTransferStore, type TransferRequest } from "@/modules/ssh/transfer-store";
import type { SessionBindingV1 } from "@/modules/terminal/lib/pty-bridge";
import { RemoteFsMutationDialog } from "@/modules/ssh/remote-fs/RemoteFsMutationDialog";
import { sshStatV1, type MutationRequestV1, type PathExpectationV1 } from "@/modules/ssh/remote-fs/bridge";
import { performRemoteMutation } from "@/modules/ssh/remote-fs/actions";
import { useModalBehavior } from "./overlays/Modal";
import {
  initialFileSearchLimit,
  maxFileSearchLimit,
  nextFileSearchLimit,
} from "./lib/file-search-pagination";
let nextLocalGrepRequest = 0;

function createLocalGrepRequestId(): string {
  nextLocalGrepRequest += 1;
  return `grep-${Date.now().toString(36)}-${nextLocalGrepRequest.toString(36)}`;
}

function SearchRetryButton({ label, onRetry }: { label: string; onRetry: () => void }) {
  return (
    <div style={{ display: "flex", justifyContent: "center", paddingTop: 6 }}>
      <button className="hover-bg" onClick={onRetry} style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-3)", border: "1px solid var(--c-border-1)", borderRadius: "var(--r-btn)", background: "transparent", cursor: "pointer", padding: "2px 10px" }}>{label}</button>
    </div>
  );
}

// Remember the chosen search mode for this run so it survives directory/session
// switches. The query itself is intentionally not remembered — it is scoped to a
// specific repo and clearing it when the root changes avoids stale lookups.
let lastFileSearchMode: "name" | "content" = "name";

interface FileExplorerProps {
  sessionId: string;
  rootDir: string;
  /**
   * 远程 SSH 会话的 PTY id。存在则文件操作走 SFTP；否则走本地 fs。
   * rootDir 有 OSC 7 识别出的绝对路径时从该 cwd 打开；旧会话标签才解析 home。
   */
  remotePtyId?: number;
  /** Backend-authored generation required by transfer/mutation v1 contracts. */
  transportGeneration?: string;
  /** Stable transport identity while the physical SSH PTY is unavailable. */
  remote?: boolean;
  remoteHost?: string;
  onInspectRemotePath?: (path: string) => void;
}

interface DownloadTransfer {
  disposed: boolean;
}

interface ExplorerTreeNode {
  entry: DirEntry;
  path: string;
  parentPath: string | null;
  level: number;
  posInSet: number;
  setSize: number;
}

interface TreeLoadError {
  kind: "readFailed";
}

export function downloadFailureKey(error: unknown): string {
  const message = String(error).toLowerCase();
  if (message.includes("destination already exists")) return "explorer.download.error_exists";
  if (message.includes("exceeds download limit")) return "explorer.download.error_limit";
  if (message.includes("under the home directory") || message.includes("refusing to write") || message.includes("download path")) {
    return "explorer.download.error_unsafe_path";
  }
  if (message.includes("write local file") || message.includes("permission") || message.includes("space")) {
    return "explorer.download.error_local_write";
  }
  if (message.includes("connection") || message.includes("transport") || message.includes("session") || message.includes("timed out") || message.includes("timeout") || message.includes("pty")) {
    return "explorer.download.error_connection";
  }
  return "explorer.download.failed_hint";
}

export interface UploadFailure {
  kind: string;
  residuePath?: string;
}

export function parseUploadFailure(error: unknown): UploadFailure {
  const raw = String(error);
  if (raw.includes("SSH_TRANSFER_CANCELLED")) return { kind: "cancelled" };
  if (raw.includes("SSH_TRANSFER_UNSUPPORTED")) return { kind: "unsupported" };
  if (raw.includes("SSH_TRANSFER_CHANGED")) return { kind: "changed" };
  if (raw.includes("SSH_TRANSFER_OUTCOME_UNKNOWN")) return { kind: "uncertain" };
  if (raw.includes("SSH_TRANSFER_PARTIAL")) return { kind: "partial" };
  const prefix = "tunaraUploadError:";
  const offset = raw.indexOf(prefix);
  if (offset >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(offset + prefix.length)) as unknown;
      if (parsed && typeof parsed === "object" && "kind" in parsed && typeof parsed.kind === "string") {
        return {
          kind: parsed.kind,
          residuePath: "residuePath" in parsed && typeof parsed.residuePath === "string"
            ? parsed.residuePath
            : undefined,
        };
      }
    } catch {
      // Fall through to compatibility matching for malformed/older errors.
    }
  }
  const message = raw.toLowerCase();
  if (message.includes("upload cancelled")) return { kind: "cancelled" };
  if (message.includes("does not support safe atomic overwrite")) return { kind: "unsupported" };
  if (message.includes("permissions changed during upload")) return { kind: "changed" };
  if (message.includes("outcome unknown after replacement")) return { kind: "uncertain" };
  if (message.includes("partial upload may remain")) return { kind: "partial" };
  return { kind: "generic" };
}

export function uploadFailureKey(error: unknown): string {
  const { kind } = parseUploadFailure(error);
  if (kind === "unsupported") return "explorer.upload.error_unsupported_overwrite";
  if (kind === "changed") return "explorer.upload.error_changed";
  if (kind === "uncertain") return "explorer.upload.error_uncertain";
  if (kind === "partial") return "explorer.upload.error_partial";
  if (kind === "cancelled") return "explorer.upload.error_cancelled";
  return "explorer.upload.failed_hint";
}

function FolderIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--c-accent)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--c-text-5)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function FileNameIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function FileContentIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="10" x2="20" y2="10" />
      <line x1="4" y1="14" x2="14" y2="14" />
    </svg>
  );
}

function SearchLimitControl({ canLoadMore, loading, onLoadMore }: { canLoadMore: boolean; loading: boolean; onLoadMore: () => void }) {
  const t = useT();
  if (loading) {
    return <div aria-live="polite" style={{ padding: "4px var(--sp-2)", color: "var(--c-text-5)", fontSize: "var(--fs-meta)" }}>{t("explorer.searching")}</div>;
  }
  return canLoadMore ? (
    <button
      type="button"
      onClick={onLoadMore}
      className="hover-bg"
      style={{ margin: "4px var(--sp-2)", padding: "4px 8px", color: "var(--c-accent)", fontSize: "var(--fs-meta)", border: "1px solid var(--c-accent-border)", borderRadius: "var(--r-btn)", background: "var(--c-accent-bg-soft)", cursor: "pointer" }}
    >
      {t("explorer.load_more")}
    </button>
  ) : (
    <div style={{ padding: "4px var(--sp-2)", color: "var(--c-text-5)", fontSize: "var(--fs-meta)" }}>{t("explorer.results_limit_reached")}</div>
  );
}

function joinPath(base: string, name: string): string {
  if (!base || base === "/") return "/" + name;
  return base.endsWith("/") ? base + name : base + "/" + name;
}

function parentPath(path: string): string {
  if (path === "/") return "/";
  const trimmed = path.endsWith("/") && path.length > 1 ? path.slice(0, -1) : path;
  const idx = trimmed.lastIndexOf("/");
  if (idx <= 0) return trimmed.startsWith("~") ? "~" : "/";
  return trimmed.slice(0, idx);
}

function compactRelativePath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 3) return path;
  return "…/" + parts.slice(-3).join("/");
}

interface UploadTransfer {
  transferId?: string;
  cancelled: boolean;
  disposed?: boolean;
  backendActive?: boolean;
  cancelRequest?: Promise<boolean>;
  lastAnnouncementAt?: number;
  lastAnnouncementPercent?: number;
}

function requestUploadCancellation(transfer: UploadTransfer): Promise<boolean> {
  if (transfer.cancelRequest) return transfer.cancelRequest;
  transfer.cancelRequest = (async () => {
    while (transfer.backendActive && transfer.transferId) {
      if (await sshCancelUpload(transfer.transferId)) return true;
      // The invoke can reach the frontend before Rust has registered the ID.
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  })();
  return transfer.cancelRequest;
}

type SortKey = "name" | "modified";
type SortDirection = "asc" | "desc";

function compareEntries(a: DirEntry, b: DirEntry, key: SortKey, direction: SortDirection): number {
  const factor = direction === "asc" ? 1 : -1;
  if (key === "modified" && a.mtime !== b.mtime) return (a.mtime - b.mtime) * factor;
  const insensitive = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  const nameOrder = insensitive !== 0 ? insensitive : a.name.localeCompare(b.name);
  return key === "modified" ? nameOrder : nameOrder * factor;
}

export function sortExplorerEntries(
  entries: readonly DirEntry[],
  key: SortKey,
  direction: SortDirection,
): DirEntry[] {
  return [...entries].sort((a, b) => compareEntries(a, b, key, direction));
}

export function formatModifiedTime(mtime: number, now = new Date()): string {
  if (!Number.isFinite(mtime) || mtime <= 0) return "—";
  const date = new Date(mtime);
  if (Number.isNaN(date.getTime())) return "—";
  if (date.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
  }
  if (date.getFullYear() === now.getFullYear()) {
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" }).format(date);
}

const folderEmptyIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
);

export function FileExplorer({
  sessionId,
  rootDir,
  remotePtyId,
  transportGeneration,
  remote = remotePtyId !== undefined,
  remoteHost,
  onInspectRemotePath,
}: FileExplorerProps) {
  const t = useT();
  const isRemote = remote;
  const remoteDisconnected = isRemote && remotePtyId === undefined;
  const [upload, setUpload] = useState<{
    transferId: string;
    fileName: string;
    transferred: number;
    total: number;
    cancelling: boolean;
  } | null>(null);
  const uploadTransferRef = useRef<UploadTransfer | null>(null);
  const [transferAnnouncement, setTransferAnnouncement] = useState("");
  const [download, setDownload] = useState<{ fileName: string } | null>(null);
  const downloadTransferRef = useRef<DownloadTransfer | null>(null);
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
  // For local sessions the base is rootDir directly. Remote sessions use an
  // OSC 7 absolute cwd when available, otherwise resolve $HOME via SFTP.
  const [baseDir, setBaseDir] = useState<string | null>(isRemote ? null : rootDir);
  const [currentPath, setCurrentPath] = useState(isRemote ? "" : rootDir);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [navDir, setNavDir] = useState<"in" | "out" | null>(null);
  const [includeHidden, setIncludeHidden] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({ key: "name", direction: "asc" });
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [searchRetryNonce, setSearchRetryNonce] = useState(0);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [searchMode, setSearchMode] = useState<"name" | "content">(lastFileSearchMode);
  const [searchLimit, setSearchLimit] = useState(() => initialFileSearchLimit(lastFileSearchMode));
  const [grepHits, setGrepHits] = useState<GrepFileGroup[]>([]);
  const [grepTruncated, setGrepTruncated] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    items: MenuEntry[];
    position: { x: number; y: number };
    bindingKey: string;
  } | null>(null);
  const externalEditor = useUIStore((s) => s.externalEditor);
  const activeFilePath = useUIStore((s) =>
    s.fileTabs.find((tab) => tab.id === s.activeFileTabId && tab.sessionId === sessionId)?.filePath,
  );
  const searchGenerationRef = useRef(new FileSearchGeneration());
  const resultsListRef = useRef<HTMLDivElement>(null);
  // 目录列表虚拟滚动：行距恒定 32px（30 按钮 + 2 margin），仅列表很长时启用
  const [listScroll, setListScroll] = useState({ top: 0, height: 0 });
  const [pendingListingFocus, setPendingListingFocus] = useState<number | null>(null);
  const [listingFocusIndex, setListingFocusIndex] = useState(0);
  const explorerRef = useRef<HTMLDivElement>(null);
  const [dropActive, setDropActive] = useState(false);
  const [dropMessage, setDropMessage] = useState("");
  const [mutationComposer, setMutationComposer] = useState<{ kind: "mkdir" | "rename"; node: ExplorerTreeNode; value: string; bindingKey: string } | null>(null);
  const [mutationRequest, setMutationRequest] = useState<MutationRequestV1 | null>(null);
  const [mutationBusy, setMutationBusy] = useState(false);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const [treeChildren, setTreeChildren] = useState<Record<string, DirEntry[]>>({});
  const [treeLoading, setTreeLoading] = useState<Set<string>>(() => new Set());
  const [treeErrors, setTreeErrors] = useState<Record<string, TreeLoadError>>({});
  const treeRequestGenerationRef = useRef(0);
  const treeRequestTokensRef = useRef(new Map<string, string>());
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
  const mutationRequestIsCurrent = !mutationRequest || !!binding
    && mutationRequest.binding.logicalSessionId === binding.logicalSessionId
    && mutationRequest.binding.physicalPtyId === binding.physicalPtyId
    && mutationRequest.binding.transportGeneration === binding.transportGeneration;
  useEffect(() => {
    if (mutationRequest && !mutationRequestIsCurrent) setMutationRequest(null);
  }, [mutationRequest, mutationRequestIsCurrent]);

  const queueLocalPaths = useCallback(async (paths: string[], destinationRoot: string) => {
    if (!binding || paths.length === 0) return false;
    const requests: TransferRequest[] = [];
    const directories: string[] = [];
    for (const localPath of paths) {
      let isDirectory = false;
      try {
        await fsReadDir(localPath, false);
        isDirectory = true;
      } catch {
        // Tauri exposes OS paths but not their kinds. Directory validation is
        // authoritative below; ordinary files continue through the file intent.
      }
      const intent = classifyTransferDrop({ localPaths: [localPath], folder: isDirectory });
      if (intent.kind === "folder") {
        const manifest = await validateManifest({ kind: "local", root: intent.root });
        const leaf = intent.root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "upload";
        const plan = expandFolderTransfer({
          manifest,
          binding,
          direction: "upload",
          sourceRoot: intent.root,
          destinationRoot: joinPath(destinationRoot, leaf),
          conflict: "rename",
        });
        directories.push(...plan.directories);
        requests.push(...plan.requests);
      } else if (intent.kind === "upload") {
        for (const source of intent.localPaths) {
          const leaf = source.split(/[\\/]/).pop() ?? "upload";
          requests.push({ binding, direction: "upload", source, destination: joinPath(destinationRoot, leaf), conflict: "rename" });
        }
      }
    }
    const conflicts: TransferRequest[] = [];
    for (const request of requests) {
      try {
        await sshStatV1(binding, request.destination);
        conflicts.push(request);
      } catch (error) {
        if (!String(error).includes("SSH_REMOTE_FS_NOT_FOUND")) throw error;
      }
    }
    if (conflicts.length > 0) {
      const endpoint = remoteHost ?? `${binding.logicalSessionId} / PTY ${binding.physicalPtyId}`;
      const replaceAll = await confirmDialog(t("transfer.preflight.message", {
        endpoint,
        root: destinationRoot,
        count: conflicts.length,
      }), { title: t("transfer.preflight.title"), kind: "warning" });
      if (replaceAll) {
        for (const conflict of conflicts) conflict.conflict = "replace";
      } else if (await confirmDialog(t("transfer.preflight.rename_all", { count: conflicts.length }), { title: t("transfer.preflight.title"), kind: "warning" })) {
        const occupied = new Set(requests.map((request) => request.destination));
        for (const conflict of conflicts) {
          let candidate = renamedSibling(conflict.destination, occupied);
          for (;;) {
            try { await sshStatV1(binding, candidate); occupied.add(candidate); candidate = renamedSibling(conflict.destination, occupied); }
            catch (error) { if (String(error).includes("SSH_REMOTE_FS_NOT_FOUND")) break; throw error; }
          }
          conflict.destination = candidate;
          conflict.conflict = "rename";
          occupied.add(conflict.destination);
        }
      } else if (await confirmDialog(t("transfer.preflight.skip_all", { count: conflicts.length }), { title: t("transfer.preflight.title"), kind: "warning" })) {
        for (const conflict of conflicts) requests.splice(requests.indexOf(conflict), 1);
      } else {
        const occupied = new Set(requests.map((request) => request.destination));
        for (const conflict of conflicts) {
          const replace = await confirmDialog(t("transfer.preflight.replace_item", { path: conflict.destination, endpoint }), { title: t("transfer.preflight.title"), kind: "warning" });
          if (replace) { conflict.conflict = "replace"; continue; }
          const rename = await confirmDialog(t("transfer.preflight.rename_item", { path: conflict.destination }), { title: t("transfer.preflight.title"), kind: "warning" });
          if (rename) {
            let candidate = renamedSibling(conflict.destination, occupied);
            for (;;) {
              try { await sshStatV1(binding, candidate); occupied.add(candidate); candidate = renamedSibling(conflict.destination, occupied); }
              catch (error) { if (String(error).includes("SSH_REMOTE_FS_NOT_FOUND")) break; throw error; }
            }
            conflict.destination = candidate;
            conflict.conflict = "rename";
            occupied.add(conflict.destination);
          } else requests.splice(requests.indexOf(conflict), 1);
        }
      }
    }
    // Folder uploads are a two-phase operation: materialize every directory
    // first (including empty ones), then publish file work to the queue. A
    // typed mutation failure aborts the whole plan so children never race a
    // missing parent and the UI never claims the folder was queued.
    try {
      for (const path of [...new Set(directories)]) {
        const parent = path.replace(/[\\/][^\\/]+$/, "") || "/";
        const parentMetadata = await sshStatV1(binding, parent);
        let existing;
        try {
          existing = await sshStatV1(binding, path);
        } catch (error) {
          if (!String(error).includes("SSH_REMOTE_FS_NOT_FOUND")) throw error;
          existing = undefined;
        }
        if (existing?.kind === "directory") continue;
        if (existing) throw new Error("folder destination already exists and is not a directory");
        const request: MutationRequestV1 = {
          operationId: nextOperationId(),
          binding,
          operation: { kind: "mkdir", path },
          precondition: { source: { state: "absent" }, sourceParent: parentMetadata.precondition },
        };
        const { result } = await performRemoteMutation(request);
        if (result.status !== "applied" && result.status !== "desiredStateObserved") {
          throw new Error("remote folder creation was not confirmed");
        }
      }
    } catch {
      setDropMessage(t("explorer.mutation.prepare_failed"));
      return false;
    }
    if (requests.length > 0) useTransferStore.getState().enqueueBatch(requests);
    setDropMessage(t("explorer.drop.queued", { files: requests.length, directories: directories.length }));
    return true;
  }, [binding, remoteHost, t]);

  useEffect(() => () => {
    const downloadTransfer = downloadTransferRef.current;
    if (downloadTransfer) {
      downloadTransfer.disposed = true;
      if (downloadTransferRef.current === downloadTransfer) downloadTransferRef.current = null;
      setDownload(null);
    }
    const transfer = uploadTransferRef.current;
    if (!transfer) return;
    transfer.cancelled = true;
    transfer.disposed = true;
    if (uploadTransferRef.current === transfer) uploadTransferRef.current = null;
    if (transfer.transferId) {
      setUpload((current) => current?.transferId === transfer.transferId ? null : current);
    }
    setTransferAnnouncement("");
    if (transfer.transferId) void requestUploadCancellation(transfer).catch(() => {});
  }, [remotePtyId, sessionId]);

  useEffect(() => {
    if (!binding) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const handleDragDrop = (event: Parameters<Parameters<ReturnType<typeof getCurrentWebview>["onDragDropEvent"]>[0]>[0]) => {
      if (disposed) return;
      if (event.payload.type === "leave") {
        setDropActive(false);
        return;
      }
      const rect = explorerRef.current?.getBoundingClientRect();
      const scale = window.devicePixelRatio || 1;
      const x = event.payload.position.x / scale;
      const y = event.payload.position.y / scale;
      const inside = rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
      if (!inside) return;
      if (event.payload.type === "enter" || event.payload.type === "over") {
        setDropActive(true);
      } else if (event.payload.type === "drop") {
        setDropActive(false);
        void queueLocalPaths(event.payload.paths, currentPath).catch((error: unknown) => {
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
  }, [binding, currentPath, queueLocalPaths, sessionId, t]);

  const uploadToRemoteDirectory = async (directory: string) => {
    if (remotePtyId === undefined || uploadTransferRef.current) return;
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
    const transfer: UploadTransfer = { cancelled: false };
    uploadTransferRef.current = transfer;
    let selected: string | string[] | null;
    try {
      selected = await openDialog({
        title: t("explorer.upload.choose_file"),
        directory: false,
        multiple: true,
      });
    } catch {
      if (!transfer.disposed) {
        useUIStore.getState().addToast({ sessionId, title: t("explorer.upload.failed"), subtitle: t("explorer.upload.failed_hint"), variant: "error" });
      }
      if (uploadTransferRef.current === transfer) uploadTransferRef.current = null;
      return;
    }
    const localPaths = selected === null ? [] : Array.isArray(selected) ? selected : [selected];
    if (localPaths.length === 0 || transfer.cancelled) {
      if (uploadTransferRef.current === transfer) uploadTransferRef.current = null;
      return;
    }
    try {
      for (const localPath of localPaths) {
        if (transfer.cancelled) break;
        const fileName = localPath.split(/[\\/]/).filter(Boolean).pop();
        if (!fileName) continue;
        const remotePath = joinPath(directory, fileName);
        const transferId = globalThis.crypto?.randomUUID?.() ?? `upload-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        transfer.transferId = transferId;
        transfer.lastAnnouncementAt = Date.now();
        transfer.lastAnnouncementPercent = 0;
        setUpload({ transferId, fileName, transferred: 0, total: 0, cancelling: false });
        setTransferAnnouncement(t("explorer.upload.announcement", { file: fileName, percent: 0 }));

        const throwIfCancelled = () => {
          if (transfer.cancelled) throw new Error("upload cancelled");
        };

        const run = async (overwrite: boolean) => {
          throwIfCancelled();
          transfer.backendActive = true;
          try {
            return await sshUpload(
              remotePtyId,
              transferId,
              localPath,
              remotePath,
              overwrite,
              ({ transferred, total }) => {
                if (!transfer.disposed) {
                  setUpload((current) => current?.transferId === transferId
                    ? { ...current, transferred, total }
                    : current);
                  const percent = total > 0 ? Math.min(100, Math.floor(transferred / total * 100)) : 0;
                  const percentBucket = Math.floor(percent / 10) * 10;
                  const now = Date.now();
                  const crossedTenPercent = percentBucket >= (transfer.lastAnnouncementPercent ?? 0) + 10;
                  const waitedTwoSeconds = now - (transfer.lastAnnouncementAt ?? now) >= 2_000;
                  if (crossedTenPercent || waitedTwoSeconds) {
                    transfer.lastAnnouncementAt = now;
                    transfer.lastAnnouncementPercent = percentBucket;
                    setTransferAnnouncement(t("explorer.upload.announcement", { file: fileName, percent }));
                  }
                }
              },
            );
          } finally {
            transfer.backendActive = false;
          }
        };

        try {
          let bytes: number;
          try {
            bytes = await run(false);
          } catch (error) {
            if (!String(error).includes("SSH_TRANSFER_DESTINATION_EXISTS")) throw error;
            throwIfCancelled();
            const overwrite = await confirmDialog(t("explorer.upload.overwrite_message", { file: fileName }), {
              title: t("explorer.upload.overwrite_title"),
              kind: "warning",
            });
            if (!overwrite) continue;
            throwIfCancelled();
            bytes = await run(true);
          }
          if (!transfer.disposed) {
            setTransferAnnouncement("");
            useUIStore.getState().addToast({
              sessionId,
              title: t("explorer.upload.complete"),
              subtitle: `${fileName} · ${formatSize(bytes)}`,
              variant: "success",
            });
            refresh();
          }
        } catch (error) {
          const failure = parseUploadFailure(error);
          if (!transfer.disposed && (failure.kind !== "cancelled" || failure.residuePath)) {
            setTransferAnnouncement("");
            const primary = t(uploadFailureKey(error));
            const residue = failure.residuePath
              ? ` ${t("explorer.upload.error_residue", { path: failure.residuePath })}`
              : "";
            useUIStore.getState().addToast({
              sessionId,
              title: t("explorer.upload.failed"),
              subtitle: `${primary}${residue}`,
              variant: "error",
            });
          }
        } finally {
          setUpload((current) => current?.transferId === transferId ? null : current);
        }
      }
    } finally {
      if (uploadTransferRef.current === transfer) uploadTransferRef.current = null;
      transfer.transferId = undefined;
      setTransferAnnouncement("");
    }
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

  const cancelUpload = () => {
    const transfer = uploadTransferRef.current;
    if (!transfer) return;
    transfer.cancelled = true;
    setTransferAnnouncement(t("explorer.upload.cancelling"));
    setUpload((current) => current ? { ...current, cancelling: true } : null);
    if (transfer.transferId && transfer.backendActive) {
      void requestUploadCancellation(transfer).catch(() => {});
    }
  };

  const openEditor = (path: string, line?: number) => {
    void openInEditorWithToast(externalEditor, path, { line });
  };

  // Resolve the starting directory. Local: rootDir. Remote: SFTP-resolved home.
  useEffect(() => {
    setNavDir(null);
    setSearchQuery("");
    // Keep the user's remembered mode preference across the root change.
    // Content search works for remote sessions too (ssh_fs_grep).
    setSearchMode(lastFileSearchMode);
    setSearchLimit(initialFileSearchLimit(lastFileSearchMode));
    if (isRemote) {
      if (remotePtyId === undefined) return;
      const knownRoot = knownRemoteExplorerRoot(rootDir);
      if (knownRoot) {
        setBaseDir(knownRoot);
        setCurrentPath(knownRoot);
        return;
      }
      let cancelled = false;
      setBaseDir(null);
      setLoading(true);
      sshHome(remotePtyId)
        .then((home) => {
          if (!cancelled) {
            setBaseDir(home);
            setCurrentPath(home);
          }
        })
        .catch(() => {
          if (!cancelled) {
            // Fall back to "/" so the panel is still usable on home-resolve fail.
            setBaseDir("/");
            setCurrentPath("/");
            // I9: surface the fallback so the user understands why the file
            // list starts at root instead of their home directory.
            useUIStore.getState().addToast({
              sessionId,
              title: staticT("explorer.remote_home_failed"),
              subtitle: "",
              variant: "warning",
            });
          }
        });
      return () => { cancelled = true; };
    }
    setBaseDir(rootDir);
    setCurrentPath(rootDir);
  }, [rootDir, isRemote, remotePtyId, sessionId]);

  useEffect(() => {
    treeRequestGenerationRef.current += 1;
    treeRequestTokensRef.current.clear();
    setTreeLoading(new Set());
    setTreeErrors({});
    if (baseDir === null) return; // remote home not resolved yet
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
          setExpandedPaths(new Set());
          setTreeChildren({});
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
  }, [currentPath, includeHidden, reloadKey, baseDir, isRemote, remotePtyId, remoteDisconnected, sessionId, transportGeneration]);

  useEffect(() => {
    const q = searchQuery.trim();
    if (!q || baseDir === null) {
      setSearchHits([]);
      setGrepHits([]);
      setGrepTruncated(false);
      setSearchTruncated(false);
      setSearchLoading(false);
      setSearchError(false);
      return;
    }
    if (remoteDisconnected) {
      setSearchLoading(false);
      return;
    }

    const mode = searchMode;
    const searchGen = searchGenerationRef.current;
    const token = searchGen.start();
    const localGrepRequestId = mode === "content" && !isRemote
      ? createLocalGrepRequestId()
      : null;
    let requestStarted = false;
    let requestSettled = false;
    setSearchLoading(true);
    setSearchError(false);
    // Fire the request inside the debounce timer, not before it: building the
    // promise eagerly would start the find/grep on every keystroke and only
    // debounce the setState. The generation token discards any in-flight
    // response when searchQuery, searchMode, baseDir, or remotePtyId changes.
    // Local content searches also send an explicit cancellation IPC so stale
    // parallel filesystem walks stop consuming CPU and disk. Both modes split local/remote:
    // content search runs fs_grep locally and ssh_fs_grep over the exec channel
    // remotely (shared GrepResponse shape); name search keeps the fs_search /
    // ssh_fs_search split with the shared SearchHit shape. The remote bridge
    // caches per (ptyId, root, query) so backspacing doesn't re-run find/grep.
    const timer = window.setTimeout(() => {
      requestStarted = true;
      const runSearch: Promise<SearchHit[] | GrepResponse> =
        mode === "content"
          ? isRemote && remotePtyId !== undefined
            ? sshGrep(remotePtyId, baseDir, q, searchLimit)
            : fsGrep(q, baseDir, { requestId: localGrepRequestId!, caseInsensitive: false, maxResults: searchLimit })
          : isRemote && remotePtyId !== undefined
            ? sshSearch(remotePtyId, baseDir, q, searchLimit)
            : fsSearch(baseDir, q, searchLimit, includeHidden);
      runSearch
        .then((result) => {
          requestSettled = true;
          if (!searchGen.isCurrent(token)) return;
          if (mode === "content") {
            const resp = result as GrepResponse;
            setGrepHits(groupGrepHitsByFile(resp.hits));
            setGrepTruncated(resp.truncated);
            setSearchHits([]);
            setSearchTruncated(false);
          } else {
            const hits = result as SearchHit[];
            setSearchHits(hits);
            // fs_search/ssh_fs_search cap results at searchLimit without a
            // truncated flag, so infer truncation from hitting the cap exactly.
            setSearchTruncated(hits.length >= searchLimit);
            setGrepHits([]);
            setGrepTruncated(false);
          }
          setSearchLoading(false);
        })
        .catch(() => {
          requestSettled = true;
          if (!searchGen.isCurrent(token)) return;
          setSearchHits([]);
          setGrepHits([]);
          setGrepTruncated(false);
          setSearchTruncated(false);
          setSearchError(true);
          setSearchLoading(false);
        });
    }, 180);

    return () => {
      searchGen.invalidate();
      window.clearTimeout(timer);
      if (localGrepRequestId && requestStarted && !requestSettled) {
        void fsCancelGrep(localGrepRequestId).catch(() => {});
      }
      if (mode === "name" && !isRemote && requestStarted && !requestSettled) {
        fsCancelActiveNameSearch();
      }
      if (isRemote && remotePtyId !== undefined && requestStarted && !requestSettled) {
        cancelRemoteSearch(remotePtyId);
      }
    };
  }, [baseDir, searchQuery, searchMode, searchLimit, includeHidden, reloadKey, isRemote, remotePtyId, remoteDisconnected, searchRetryNonce]);

  const canGoUp = currentPath !== "/" && (isRemote || currentPath !== baseDir);
  const breadcrumbRoot = baseDir !== null
    && (currentPath === baseDir || currentPath.startsWith(`${baseDir}/`))
    ? baseDir
    : "/";
  const visibleTreeNodes = useMemo(() => {
    const result: ExplorerTreeNode[] = [];
    const append = (siblings: DirEntry[], parent: string, parentLevel: number, parentPath: string | null) => {
      const sorted = [
        ...sortExplorerEntries(siblings.filter((entry) => entry.kind === "dir"), sort.key, sort.direction),
        ...sortExplorerEntries(siblings.filter((entry) => entry.kind !== "dir"), sort.key, sort.direction),
      ];
      sorted.forEach((entry, index) => {
        const path = joinPath(parent, entry.name);
        result.push({ entry, path, parentPath, level: parentLevel, posInSet: index + 1, setSize: sorted.length });
        if (entry.kind === "dir" && expandedPaths.has(path) && treeChildren[path]) {
          append(treeChildren[path], path, parentLevel + 1, path);
        }
      });
    };
    append(entries, currentPath, 1, null);
    return result;
  }, [entries, currentPath, expandedPaths, treeChildren, sort]);
  const isSearching = searchQuery.trim().length > 0;
  const searchMaxLimit = maxFileSearchLimit(searchMode, isRemote);

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
    const index = visibleTreeNodes.findIndex((node) => node.path === path);
    if (index >= 0) setListingFocusIndex(index);
  }, [visibleTreeNodes, isSearching]);

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

  function loadMoreSearchResults() {
    setSearchLimit((current) => nextFileSearchLimit(current, searchMode, isRemote));
  }

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
      const index = visibleTreeNodes.findIndex((node) => node.path === path);
      if (index >= 0) focusTreeIndex(index);
    });
  }

  const nextOperationId = () => globalThis.crypto?.randomUUID?.()
    ?? `remote-fs-${Date.now()}-${Math.random().toString(36).slice(2)}`;

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
            { id: "dir:download", label: t("explorer.capability.directory_download_unavailable"), icon: "download", disabled: true, action: () => {} },
            { id: "dir:rename", label: t("explorer.mutation.rename"), icon: "rename", action: () => { suppressMenuFocusRef.current = true; setMutationComposer({ kind: "rename", node, value: node.entry.name, bindingKey: treeRequestContext }); } },
            { id: "dir:delete", label: t("explorer.mutation.delete"), icon: "close", danger: true, action: () => { suppressMenuFocusRef.current = true; void prepareDelete(node); } },
            { id: "dir:metadata", label: t("explorer.metadata"), icon: "search", action: () => { suppressMenuFocusRef.current = true; onInspectRemotePath?.(node.path); } },
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
          { id: "file:rename", label: t("explorer.mutation.rename"), icon: "rename", action: () => { suppressMenuFocusRef.current = true; setMutationComposer({ kind: "rename", node, value: node.entry.name, bindingKey: treeRequestContext }); } },
          { id: "file:delete", label: t("explorer.mutation.delete"), icon: "close", danger: true, action: () => { suppressMenuFocusRef.current = true; void prepareDelete(node); } },
          { id: "file:metadata", label: t("explorer.metadata"), icon: "search", action: () => { suppressMenuFocusRef.current = true; onInspectRemotePath?.(node.path); } },
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

  function renderTreeNode(node: ExplorerTreeNode) {
    const listingIndex = visibleTreeNodes.findIndex((candidate) => candidate.path === node.path);
    const isDir = node.entry.kind === "dir";
    const expanded = isDir && expandedPaths.has(node.path);
    const children = visibleTreeNodes.filter((candidate) => candidate.parentPath === node.path);
    const active = activeFilePath === node.path;
    const openMenu = (x: number, y: number, opener: HTMLElement) => {
      menuReturnPathRef.current = node.path;
      menuReturnFocusRef.current = opener;
      setContextMenu({ position: { x, y }, items: treeMenuItems(node), bindingKey: treeRequestContext });
    };
    return (
      <div
        key={node.path}
        role="treeitem"
        aria-level={node.level}
        aria-expanded={isDir ? expanded : undefined}
        aria-setsize={node.setSize}
        aria-posinset={node.posInSet}
        data-explorer-item
        data-listing-index={listingIndex}
        data-tree-path={node.path}
        data-file-path={!isDir ? node.path : undefined}
        tabIndex={listingFocusIndex === listingIndex ? 0 : -1}
        onFocus={(event) => {
          if (event.target !== event.currentTarget) return;
          focusedPathRef.current = node.path;
          setListingFocusIndex(listingIndex);
        }}
        onClick={(event) => {
          if (event.target !== event.currentTarget && (event.target as HTMLElement).closest("[role=group]")) return;
          if (isDir) { setNavDir("in"); setCurrentPath(node.path); } else openFile(node.path);
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
              setExpandedPaths((current) => { const next = new Set(current); next.delete(node.path); return next; });
            } else if (node.parentPath) {
              event.preventDefault(); event.stopPropagation();
              focusTreeIndex(visibleTreeNodes.findIndex((candidate) => candidate.path === node.parentPath));
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
        className="hover-bg"
        style={{ width: "100%", minHeight: 30, padding: `0 var(--sp-1) 0 ${8 + (node.level - 1) * 16}px`, borderRadius: "var(--r-btn)", border: "none", background: active ? "var(--c-accent-bg-light)" : "transparent", cursor: "pointer", display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(42px, 92px) 28px", columnGap: 4, alignItems: "center", textAlign: "left", marginBottom: 2 }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, height: 30, pointerEvents: "none" }}>
          {isDir ? <FolderIcon /> : <FileIcon />}
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--c-text-2)" }}>{node.entry.name}</span>
          {isDir && <span aria-hidden="true" style={{ fontSize: 10 }}>{expanded ? "⌄" : "›"}</span>}
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
        {isDir && expanded && children.length > 0 && (
          <div role="group" style={{ gridColumn: "1 / -1", marginLeft: -8 }}>
            {children.map(renderTreeNode)}
          </div>
        )}
        {isDir && expanded && treeErrors[node.path]?.kind === "readFailed" && (
          <div role="group" style={{ gridColumn: "1 / -1", padding: "2px 0 4px 22px" }}>
            <div role="alert" style={{ color: "var(--c-danger)", fontSize: "var(--fs-meta)" }}>
              {t("explorer.read_dir_failed")}
            </div>
            <button type="button" onClick={() => expandDirectory(node.path)}>
              {t("explorer.search_retry")}
            </button>
          </div>
        )}
      </div>
    );
  }

  function openSearchDir(path: string) {
    setSearchQuery("");
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
          ↥ {t("explorer.drop.ready")}
        </div>
      )}
      {dropMessage && <div role="status" aria-live="polite" className="sr-only">{dropMessage}</div>}
      {remoteDisconnected && (
        <div role="status" aria-live="polite" style={{ flexShrink: 0, padding: "5px var(--sp-2)", color: "var(--c-warning)", background: "color-mix(in srgb, var(--c-warning) 8%, transparent)", borderBottom: "1px solid var(--c-border-1)", fontSize: "var(--fs-meta)" }}>
          {t("explorer.remote_disconnected")}
        </div>
      )}
      <div style={{ height: 36, borderBottom: "1px solid var(--c-border-1)", display: "flex", alignItems: "center", padding: "0 var(--sp-2)", gap: 4, flexShrink: 0 }}>
        <button
          onClick={() => { if (canGoUp) goUp(); }}
          disabled={!canGoUp}
          aria-disabled={!canGoUp}
          className="hover-bg"
          title={t("explorer.go_up")}
          aria-label={t("explorer.go_up")}
          style={{
            width: 26, height: 26, borderRadius: "var(--r-btn)", border: "none",
            background: "transparent", cursor: canGoUp ? "pointer" : "not-allowed",
            display: "flex", alignItems: "center", justifyContent: "center",
            opacity: canGoUp ? 1 : 0.3, flexShrink: 0, pointerEvents: canGoUp ? "auto" : "none",
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div title={currentPath} style={{ display: "flex", alignItems: "center", gap: 2, flex: 1, minWidth: 0, padding: "0 var(--sp-1)", overflow: "hidden", whiteSpace: "nowrap" }}>
          {breadcrumbSegments(currentPath, breadcrumbRoot).map((seg, idx, arr) => {
            const isLast = idx === arr.length - 1;
            const isCurrent = seg.targetPath === currentPath;
            const showSeparator = idx < arr.length - 1;
            return (
              <span key={`${idx}:${seg.targetPath}`} style={{ display: "inline-flex", alignItems: "center", gap: 2, minWidth: 0 }}>
                <button
                  onClick={() => {
                    if (isCurrent) return;
                    setNavDir("out");
                    setCurrentPath(seg.targetPath);
                  }}
                  disabled={isCurrent}
                  aria-current={isCurrent ? "page" : undefined}
                  className={isCurrent ? undefined : "hover-bg"}
                  title={seg.isCollapsed ? seg.targetPath : seg.label}
                  style={{
                    height: 20,
                    padding: "0 5px",
                    borderRadius: "var(--r-btn)",
                    border: "none",
                    background: "transparent",
                    cursor: isCurrent ? "default" : "pointer",
                    fontSize: "var(--fs-meta)",
                    lineHeight: "16px",
                    fontFamily: "var(--font-mono)",
                    color: isLast ? "var(--c-text-3)" : undefined,
                    fontWeight: isLast ? 500 : 400,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    minWidth: seg.isCollapsed ? undefined : 24,
                    flexShrink: seg.isCollapsed ? 0 : 1,
                  }}
                >
                  {seg.label}
                </button>
                {showSeparator && (
                  <span style={{ fontSize: "var(--fs-meta)", lineHeight: "16px", color: "var(--c-text-6)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>›</span>
                )}
              </span>
            );
          })}
        </div>
        <button
          onClick={refresh}
          className="hover-bg"
          title={t("explorer.refresh")}
          aria-label={t("explorer.refresh")}
          style={{ width: 26, height: 26, borderRadius: "var(--r-btn)", border: "none", background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
        >
          <RefreshIcon />
        </button>
        {isRemote && (
          <>
            <button
              onClick={() => { void uploadToRemoteDirectory(currentPath); }}
              disabled={remoteDisconnected || upload !== null}
              className="hover-bg"
              title={t("explorer.upload")}
              aria-label={t("explorer.upload")}
              style={{ width: 26, height: 26, borderRadius: "var(--r-btn)", border: "none", background: "transparent", color: "var(--c-text-4)", cursor: remoteDisconnected || upload ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: 17 }}
            >
              ↑
            </button>
            {binding && (
              <button
                onClick={() => { void uploadFolderToRemoteDirectory(currentPath); }}
                disabled={remoteDisconnected}
                className="hover-bg"
                title={t("explorer.upload_folder")}
                aria-label={t("explorer.upload_folder")}
                style={{ width: 26, height: 26, borderRadius: "var(--r-btn)", border: "none", background: "transparent", color: "var(--c-text-4)", cursor: remoteDisconnected ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
              >
                <span aria-hidden="true">↥▣</span>
              </button>
            )}
          </>
        )}
        <button
          onClick={() => setIncludeHidden((v) => !v)}
          className="hover-bg"
          title={includeHidden ? t("explorer.hide_dotfiles") : t("explorer.show_dotfiles")}
          aria-label={includeHidden ? t("explorer.hide_dotfiles") : t("explorer.show_dotfiles")}
          aria-pressed={includeHidden}
          style={{
            height: 26,
            minWidth: 26,
            padding: "0 var(--sp-2)",
            borderRadius: "var(--r-btn)",
            border: "none",
            background: includeHidden ? "var(--c-accent-bg-light)" : "transparent",
            color: includeHidden ? "var(--c-accent)" : "var(--c-text-5)",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "var(--fs-meta)",
            lineHeight: "16px",
            fontFamily: "var(--font-mono)",
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          .*
        </button>
      </div>

      {upload && (
        <div style={{ padding: "6px var(--sp-2)", borderBottom: "1px solid var(--c-border-1)", background: "var(--c-bg-2)", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "var(--fs-meta)", color: "var(--c-text-3)" }}>
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
              {upload.cancelling ? t("explorer.upload.cancelling") : t("explorer.upload.progress", { file: upload.fileName, percent: upload.total > 0 ? Math.min(100, Math.round(upload.transferred / upload.total * 100)) : 0 })}
            </span>
            <button type="button" onClick={cancelUpload} disabled={upload.cancelling} className="hover-bg" style={{ border: "none", background: "transparent", color: "var(--c-text-4)", cursor: upload.cancelling ? "default" : "pointer", padding: "2px 5px", borderRadius: "var(--r-btn)", fontSize: "var(--fs-meta)" }}>{t("explorer.upload.cancel")}</button>
          </div>
          <progress aria-label={t("explorer.upload.progress_label")} max={upload.total || 1} value={upload.transferred} style={{ display: "block", width: "100%", height: 4, marginTop: 5, accentColor: "var(--c-accent)" }} />
        </div>
      )}
      <div aria-live="polite" aria-atomic="true" className="sr-only" data-transfer-announcement>
        {transferAnnouncement}
      </div>
      {download && (
        <div role="status" aria-live="polite" aria-busy="true" style={{ padding: "7px var(--sp-2)", borderBottom: "1px solid var(--c-border-1)", background: "var(--c-bg-2)", fontSize: "var(--fs-meta)", color: "var(--c-text-3)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={download.fileName}>
          {t("explorer.download.progress", { file: download.fileName })}
          <progress aria-label={t("explorer.download.progress_label")} style={{ display: "block", width: "100%", height: 4, marginTop: 5 }} />
        </div>
      )}

      <div
        style={{ padding: "6px var(--sp-2)", borderBottom: "1px solid var(--c-border-1)", flexShrink: 0 }}
      >
        <div className="explorer-search" style={{ background: "var(--c-bg-3)", borderRadius: "var(--r-input)", display: "flex", alignItems: "center", gap: 7, padding: "5px var(--sp-2)", border: "1px solid transparent", transition: "border-color var(--duration-fast) ease, box-shadow var(--duration-fast) ease" }}>
          <button
            onClick={() => {
              setSearchMode((m) => {
                const next = m === "name" ? "content" : "name";
                lastFileSearchMode = next;
                setSearchLimit(initialFileSearchLimit(next));
                return next;
              });
              setSearchQuery("");
            }}
            title={searchMode === "name" ? t("explorer.search_mode.switch_to_content") : t("explorer.search_mode.switch_to_name")}
            aria-label={searchMode === "name" ? t("explorer.search_mode.switch_to_content") : t("explorer.search_mode.switch_to_name")}
            aria-pressed={searchMode === "content"}
            className="hover-bg"
            style={{ width: 18, height: 18, borderRadius: "var(--r-btn)", border: "none", background: searchMode === "content" ? "var(--c-accent-bg-light)" : "transparent", color: searchMode === "content" ? "var(--c-accent)" : "var(--c-text-5)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
          >
            {searchMode === "content" ? <FileContentIcon /> : <FileNameIcon />}
          </button>
          <SearchIcon />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setSearchLimit(initialFileSearchLimit(searchMode));
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                // Esc 先清空，已空则让出焦点
                if (searchQuery) {
                  setSearchQuery("");
                  setSearchLimit(initialFileSearchLimit(searchMode));
                } else {
                  (e.currentTarget as HTMLInputElement).blur();
                }
              } else if (e.key === "ArrowDown") {
                // 下箭头从搜索框直达第一个结果按钮
                const first = resultsListRef.current?.querySelector<HTMLElement>("[data-explorer-item]");
                if (first) {
                  e.preventDefault();
                  first.focus();
                }
              }
            }}
            placeholder={searchMode === "content" ? t("explorer.search_placeholder_content") : t("explorer.search_placeholder")}
            style={{ flex: 1, border: "none", background: "transparent", outline: "none", fontSize: "var(--fs-secondary)", color: "var(--c-text-primary)", fontFamily: "var(--font-ui)", minWidth: 0 }}
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="hover-bg"
              title={t("explorer.clear_search")}
              aria-label={t("explorer.clear_search")}
              style={{ width: 18, height: 18, borderRadius: "var(--r-btn)", border: "none", background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--c-text-5)", flexShrink: 0 }}
            >
              <CloseIcon size={11} strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>

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
                <SearchRetryButton label={t("explorer.search_retry")} onRetry={() => setSearchRetryNonce((n) => n + 1)} />
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
                {(grepTruncated || searchLoading) && <SearchLimitControl canLoadMore={searchLimit < searchMaxLimit} loading={searchLoading} onLoadMore={loadMoreSearchResults} />}
              </>
            )
          ) : (
          searchLoading && searchHits.length === 0 ? (
            <PanelLoadingState label={t("explorer.searching")} />
          ) : searchError ? (
            <>
              <PanelEmptyState label={t("explorer.search_failed")} sublabel={searchQuery.trim()} />
              <SearchRetryButton label={t("explorer.search_retry")} onRetry={() => setSearchRetryNonce((n) => n + 1)} />
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
                      {hit.isDir && <span style={{ fontSize: 10, color: "var(--c-text-6)", flexShrink: 0 }}>›</span>}
                    </button>
                  </div>
                );
              })}
              {(searchTruncated || searchLoading) && <SearchLimitControl canLoadMore={searchLimit < searchMaxLimit} loading={searchLoading} onLoadMore={loadMoreSearchResults} />}
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
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 92px", columnGap: 6, alignItems: "center", height: 24, padding: "0 var(--sp-2)", marginBottom: 3, borderBottom: "1px solid var(--c-border-1)" }}>
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
            <div role="tree" aria-label={t("explorer.file_list")}>
              {virtualizeListing && <div aria-hidden="true" role="presentation" style={{ height: listingSlice.topPad }} />}
              {visibleTreeNodes
                .filter((node) => node.parentPath === null)
                .slice(listingSlice.first, listingSlice.last)
                .map(renderTreeNode)}
              {virtualizeListing && <div aria-hidden="true" role="presentation" style={{ height: listingSlice.bottomPad }} />}
            </div>
          </>
        )}
      </div>

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
                autoFocus
                value={mutationComposer.value}
                onChange={(event) => setMutationComposer((current) => current ? { ...current, value: event.target.value } : current)}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void prepareNamedMutation(); } }}
              />
            </label>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button type="button" onClick={() => { setMutationComposer(null); restoreMenuFocus(); }} disabled={mutationBusy}>{t("common.cancel")}</button>
              <button type="button" onClick={() => { void prepareNamedMutation(); }} disabled={mutationBusy || !mutationComposer.value.trim()}>{t("common.continue")}</button>
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
