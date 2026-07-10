import { useEffect, useMemo, useRef, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
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
  sshGrep,
  sshHome,
  sshReadDir,
  sshSearch,
} from "@/modules/ssh/remote-fs-bridge";
import { formatSize } from "./types";
import { FilePreview } from "./FilePreview";
import { CloseIcon, RefreshIcon, SearchIcon, PanelEmptyState, PanelLoadingState } from "./shared";
import { ContextMenu, type MenuEntry } from "./ContextMenu";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { openInEditorWithToast } from "./lib/open-in-editor";
import { useT, t as staticT } from "@/modules/i18n";
import { breadcrumbSegments } from "./lib/breadcrumbs";
import { copyText } from "./lib/clipboard";
import { groupGrepHitsByFile, type GrepFileGroup } from "@/modules/fs/lib/grep-group";
import { knownRemoteExplorerRoot } from "./lib/file-explorer-root";
import { FileSearchGeneration } from "./lib/file-search-session";
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

// Remember the chosen search mode for this run so it survives directory/session
// switches. The query itself is intentionally not remembered — it is scoped to a
// specific repo and clearing it when the root changes avoids stale lookups.
let lastFileSearchMode: "name" | "content" = "name";

interface FileExplorerProps {
  rootDir: string;
  /**
   * 远程 SSH 会话的 PTY id。存在则文件操作走 SFTP；否则走本地 fs。
   * rootDir 有 OSC 7 识别出的绝对路径时从该 cwd 打开；旧会话标签才解析 home。
   */
  remotePtyId?: number;
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

const folderEmptyIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
  </svg>
);

export function FileExplorer({ rootDir, remotePtyId }: FileExplorerProps) {
  const t = useT();
  const isRemote = remotePtyId !== undefined;

  const downloadRemoteFile = async (remotePath: string, fileName: string) => {
    if (remotePtyId === undefined) return;
    const localPath = await saveDialog({
      title: t("explorer.download.choose_destination"),
      defaultPath: fileName,
    });
    if (!localPath) return;
    try {
      const bytes = await sshDownload(remotePtyId, remotePath, localPath);
      useUIStore.getState().addToast({
        sessionId: useSessionsStore.getState().activeSessionId ?? undefined,
        title: t("explorer.download.complete"),
        subtitle: `${fileName} · ${formatSize(bytes)}`,
        variant: "success",
      });
    } catch (error) {
      useUIStore.getState().addToast({
        sessionId: useSessionsStore.getState().activeSessionId ?? undefined,
        title: t("explorer.download.failed"),
        subtitle: String(error),
        variant: "error",
      });
    }
  };
  // For local sessions the base is rootDir directly. Remote sessions use an
  // OSC 7 absolute cwd when available, otherwise resolve $HOME via SFTP.
  const [baseDir, setBaseDir] = useState<string | null>(isRemote ? null : rootDir);
  const [currentPath, setCurrentPath] = useState(isRemote ? "" : rootDir);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);
  const [navDir, setNavDir] = useState<"in" | "out" | null>(null);
  const [includeHidden, setIncludeHidden] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [searchMode, setSearchMode] = useState<"name" | "content">(lastFileSearchMode);
  const [searchLimit, setSearchLimit] = useState(() => initialFileSearchLimit(lastFileSearchMode));
  const [grepHits, setGrepHits] = useState<GrepFileGroup[]>([]);
  const [grepTruncated, setGrepTruncated] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    items: MenuEntry[];
    position: { x: number; y: number };
  } | null>(null);
  const externalEditor = useUIStore((s) => s.externalEditor);
  const searchGenerationRef = useRef(new FileSearchGeneration());

  const openEditor = (path: string, line?: number) => {
    void openInEditorWithToast(externalEditor, path, { line });
  };

  // Resolve the starting directory. Local: rootDir. Remote: SFTP-resolved home.
  useEffect(() => {
    setNavDir(null);
    setExpandedFile(null);
    setSearchQuery("");
    // Keep the user's remembered mode preference across the root change.
    // Content search works for remote sessions too (ssh_fs_grep).
    setSearchMode(lastFileSearchMode);
    setSearchLimit(initialFileSearchLimit(lastFileSearchMode));
    if (isRemote && remotePtyId !== undefined) {
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
              sessionId: useSessionsStore.getState().activeSessionId ?? "",
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
  }, [rootDir, isRemote, remotePtyId]);

  useEffect(() => {
    if (baseDir === null) return; // remote home not resolved yet
    let cancelled = false;
    setLoading(true);
    setError(false);
    setExpandedFile(null);
    const read =
      isRemote && remotePtyId !== undefined
        ? sshReadDir(remotePtyId, currentPath, includeHidden)
        : fsReadDir(currentPath, includeHidden);
    read
      .then((e) => {
        if (!cancelled) {
          setEntries(e);
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
  }, [currentPath, includeHidden, reloadKey, baseDir, isRemote, remotePtyId]);

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
  }, [baseDir, searchQuery, searchMode, searchLimit, includeHidden, reloadKey, isRemote, remotePtyId]);

  useEffect(() => {
    if (!expandedFile) return;
    const closePreview = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // Let the top-most modal own Escape. The preview is background inspector
      // state and should only close once no dialog is covering it.
      if (document.querySelector('[role="dialog"]')) return;
      event.preventDefault();
      setExpandedFile(null);
    };
    window.addEventListener("keydown", closePreview);
    return () => window.removeEventListener("keydown", closePreview);
  }, [expandedFile]);

  const canGoUp = currentPath !== "/" && currentPath !== baseDir;
  const dirs = useMemo(() => entries.filter((e) => e.kind === "dir"), [entries]);
  const files = useMemo(() => entries.filter((e) => e.kind !== "dir"), [entries]);
  const isSearching = searchQuery.trim().length > 0;
  const searchMaxLimit = maxFileSearchLimit(searchMode, isRemote);

  function loadMoreSearchResults() {
    setSearchLimit((current) => nextFileSearchLimit(current, searchMode, isRemote));
  }

  function refresh() {
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

  function enterDir(name: string) {
    setNavDir("in");
    setCurrentPath(joinPath(currentPath, name));
  }

  function openSearchDir(path: string) {
    setSearchQuery("");
    setNavDir("in");
    setCurrentPath(path);
  }

  function toggleFile(name: string) {
    const fullPath = joinPath(currentPath, name);
    setExpandedFile((prev) => (prev === fullPath ? null : fullPath));
  }

  function toggleSearchFile(path: string) {
    setExpandedFile((prev) => (prev === path ? null : path));
  }

  const contentKey = isSearching ? `search:${searchQuery}` : currentPath;
  const previewFileName = expandedFile
    ? expandedFile.split("/").filter(Boolean).pop() ?? expandedFile
    : "";

  return (
    <div
      style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, position: "relative", overflow: "hidden" }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && expandedFile) {
          event.stopPropagation();
          setExpandedFile(null);
        }
      }}
    >
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
          {breadcrumbSegments(currentPath, baseDir ?? currentPath).map((seg, idx, arr) => {
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

      {expandedFile && (
        <div
          key={expandedFile}
          style={{
            position: "absolute",
            top: 36,
            right: 0,
            bottom: 0,
            left: 0,
            zIndex: 3,
            background: "var(--c-bg-white)",
            animation: "slideInRight var(--duration-normal) var(--ease-out-expo)",
          }}
        >
          <FilePreview
            filePath={expandedFile}
            fileName={previewFileName}
            remotePtyId={remotePtyId}
            onClose={() => setExpandedFile(null)}
            fill
          />
        </div>
      )}

      <div
        aria-hidden={expandedFile ? true : undefined}
        inert={expandedFile ? true : undefined}
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
        aria-hidden={expandedFile ? true : undefined}
        inert={expandedFile ? true : undefined}
        style={{ flex: 1, overflowY: "auto", padding: "6px var(--sp-2)", animation: !isSearching && navDir ? `${navDir === "in" ? "slideInRight" : "slideInLeft"} var(--duration-normal) var(--ease-out-expo)` : undefined }}
        className="no-scrollbar scroll-fade-y"
      >
        {isSearching ? (
          searchMode === "content" ? (
            searchLoading && grepHits.length === 0 ? (
              <PanelLoadingState label={t("explorer.searching")} />
            ) : searchError ? (
              <PanelEmptyState label={t("explorer.search_failed")} sublabel={searchQuery.trim()} />
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
                        // Local hits jump to the matched line in the external
                        // editor; remote paths mean nothing to a local editor,
                        // so they open the same full-height remote preview state
                        // (same affordance as remote name-search hits).
                        onClick={() => isRemote
                          ? toggleSearchFile(group.path)
                          : openEditor(group.path, ln.line)}
                        title={isRemote ? group.rel : t("explorer.search_mode.open_at_line", { line: ln.line })}
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
            <PanelEmptyState label={t("explorer.search_failed")} sublabel={searchQuery.trim()} />
          ) : searchHits.length === 0 ? (
            <PanelEmptyState label={t("explorer.no_match")} sublabel={searchQuery.trim()} />
          ) : (
            <>
              <div style={{ padding: "3px 6px 7px", display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: "var(--fs-meta)", lineHeight: "16px", color: "var(--c-text-5)", fontFamily: "var(--font-mono)" }}>{t("explorer.results")}</span>
                <span style={{ fontSize: "var(--fs-meta)", lineHeight: "16px", color: "var(--c-text-5)", background: "var(--c-bg-3)", borderRadius: "var(--r-pill)", padding: "0 6px", fontFamily: "var(--font-mono)", minWidth: 18, textAlign: "center" }}>{searchHits.length}</span>
              </div>
              {searchHits.map((hit) => {
                const isExpanded = expandedFile === hit.path;
                return (
                  <div key={hit.path}>
                    <button
                      onClick={() => hit.isDir ? openSearchDir(hit.path) : toggleSearchFile(hit.path)}
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
            {dirs.map((entry) => {
              const fullPath = joinPath(currentPath, entry.name);
              return (
              <button
                key={"d-" + entry.name}
                onClick={() => enterDir(entry.name)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setContextMenu({
                    position: { x: e.clientX, y: e.clientY },
                    items: isRemote
                      ? [
                          { id: "dir:copy-path", label: t("sidebar.dir.copy_path"), icon: "copy", action: () => { void copyText(fullPath); } },
                        ]
                      : [
                          { id: "dir:new-terminal", label: t("sidebar.dir.new_terminal"), icon: "terminal", action: () => useSessionsStore.getState().newTerminalInDir(fullPath) },
                          { id: "dir:open-editor", label: t("sidebar.dir.open_in_editor"), icon: "editor", action: () => { openEditor(fullPath); } },
                          { id: "dir:copy-path", label: t("sidebar.dir.copy_path"), icon: "copy", action: () => { void copyText(fullPath); } },
                        ],
                  });
                }}
                className="hover-bg"
                style={{ width: "100%", height: 30, padding: "0 var(--sp-2)", borderRadius: "var(--r-btn)", border: "none", background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, textAlign: "left", marginBottom: 2 }}
              >
                <FolderIcon />
                <span style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-2)", fontWeight: 500, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.name}</span>
                <span style={{ fontSize: 10, color: "var(--c-text-6)", flexShrink: 0 }}>›</span>
              </button>
              );
            })}

            {dirs.length > 0 && files.length > 0 && (
              <div style={{ borderTop: "1px solid var(--c-border-2)", margin: "4px 0" }} />
            )}

            {files.map((entry) => {
              const fullPath = joinPath(currentPath, entry.name);
              const isExpanded = expandedFile === fullPath;
              return (
                <div key={"f-" + entry.name}>
                  <button
                    onClick={() => toggleFile(entry.name)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setContextMenu({
                        position: { x: e.clientX, y: e.clientY },
                        items: isRemote
                          ? [
                              { id: "file:download", label: t("explorer.download"), icon: "download", action: () => { void downloadRemoteFile(fullPath, entry.name); } },
                              { id: "file:copy-path", label: t("sidebar.dir.copy_path"), icon: "copy", action: () => { void copyText(fullPath); } },
                            ]
                          : [
                              { id: "file:open-editor", label: t("sidebar.dir.open_in_editor"), icon: "editor", action: () => { openEditor(fullPath); } },
                              { id: "file:copy-path", label: t("sidebar.dir.copy_path"), icon: "copy", action: () => { void copyText(fullPath); } },
                            ],
                      });
                    }}
                    className="hover-bg"
                    style={{
                      width: "100%", height: 30, padding: "0 var(--sp-2)", borderRadius: "var(--r-btn)", border: "none",
                      background: isExpanded ? "var(--c-accent-bg-light)" : "transparent",
                      cursor: "pointer", display: "flex", alignItems: "center", gap: 6, textAlign: "left", marginBottom: 2,
                    }}
                  >
                    <FileIcon />
                    <span style={{ fontSize: "var(--fs-secondary)", color: isExpanded ? "var(--c-text-primary)" : "var(--c-text-2)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)" }}>{entry.name}</span>
                    <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)", flexShrink: 0, minWidth: 48, textAlign: "right" }}>{formatSize(entry.size)}</span>
                  </button>
                </div>
              );
            })}
          </>
        )}
      </div>

      {contextMenu && (
        <ContextMenu
          items={contextMenu.items}
          position={contextMenu.position}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}
