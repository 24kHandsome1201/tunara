import { useEffect, useMemo, useState } from "react";
import { fsGrep, fsReadDir, fsSearch, type DirEntry, type GrepResponse, type SearchHit } from "@/modules/fs/fs-bridge";
import { sshReadDir, sshHome, sshSearch, sshGrep, invalidateRemoteSearchCache } from "@/modules/ssh/remote-fs-bridge";
import { formatSize } from "./types";
import { FilePreview } from "./FilePreview";
import { CloseIcon, RefreshIcon, SearchIcon, PanelEmptyState, PanelLoadingState } from "./shared";
import { ContextMenu, type MenuEntry } from "./ContextMenu";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { openInEditor } from "@/modules/editor/open";
import { useT, t as staticT } from "@/modules/i18n";
import { breadcrumbSegments } from "./lib/breadcrumbs";
import { copyText } from "./lib/clipboard";
import { groupGrepHitsByFile, type GrepFileGroup } from "@/modules/fs/lib/grep-group";

// Cap for name search (fs_search / ssh_fs_search). The backend truncates at this
// count without a flag, so hitting it exactly is treated as "more results exist".
const NAME_SEARCH_LIMIT = 80;

// Remember the chosen search mode for this run so it survives directory/session
// switches. The query itself is intentionally not remembered — it is scoped to a
// specific repo and clearing it when the root changes avoids stale lookups.
let lastFileSearchMode: "name" | "content" = "name";

interface FileExplorerProps {
  rootDir: string;
  /**
   * 远程 SSH 会话的 PTY id。存在则文件操作走 SFTP；否则走本地 fs。
   * 远程模式下 rootDir 形如 user@host，需先解析远程 home 作为起点。
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
  // For local sessions the base is rootDir directly; for remote we resolve the
  // remote $HOME via SFTP (rootDir is user@host, not a path). null = unresolved.
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
  const [grepHits, setGrepHits] = useState<GrepFileGroup[]>([]);
  const [grepTruncated, setGrepTruncated] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    items: MenuEntry[];
    position: { x: number; y: number };
  } | null>(null);
  const externalEditor = useUIStore((s) => s.externalEditor);

  // Editor launch failures (editor missing / not on PATH) surface as a toast,
  // matching DiffPanel's open-in-editor affordance instead of failing silently.
  const openEditor = (path: string, line?: number) => {
    openInEditor(externalEditor, path, line).catch(() => {
      useUIStore.getState().addToast({
        sessionId: useSessionsStore.getState().activeSessionId ?? "",
        title: t("diff.toast.editor_not_found"),
        subtitle: externalEditor,
        variant: "error",
      });
    });
  };

  // Resolve the starting directory. Local: rootDir. Remote: SFTP-resolved home.
  useEffect(() => {
    setNavDir(null);
    setExpandedFile(null);
    setSearchQuery("");
    // Keep the user's remembered mode preference across the root change.
    // Content search works for remote sessions too (ssh_fs_grep).
    setSearchMode(lastFileSearchMode);
    if (isRemote && remotePtyId !== undefined) {
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
    let cancelled = false;
    setSearchLoading(true);
    setSearchError(false);
    // Fire the request inside the debounce timer, not before it: building the
    // promise eagerly would start the find/grep on every keystroke and only
    // debounce the setState. `cancelled` discards any in-flight response when a
    // newer query supersedes this effect, so stale results never overwrite the
    // latest. Both modes split local/remote: content search runs fs_grep
    // locally and ssh_fs_grep over the exec channel remotely (shared
    // GrepResponse shape); name search keeps the fs_search / ssh_fs_search
    // split with the shared SearchHit shape. The remote bridge caches per
    // (ptyId, root, query) so backspacing doesn't re-run find/grep.
    const timer = window.setTimeout(() => {
      const runSearch: Promise<SearchHit[] | GrepResponse> =
        mode === "content"
          ? isRemote && remotePtyId !== undefined
            ? sshGrep(remotePtyId, baseDir, q)
            : fsGrep(q, baseDir, { caseInsensitive: false })
          : isRemote && remotePtyId !== undefined
            ? sshSearch(remotePtyId, baseDir, q, NAME_SEARCH_LIMIT)
            : fsSearch(baseDir, q, NAME_SEARCH_LIMIT, includeHidden);
      runSearch
        .then((result) => {
          if (cancelled) return;
          if (mode === "content") {
            const resp = result as GrepResponse;
            setGrepHits(groupGrepHitsByFile(resp.hits));
            setGrepTruncated(resp.truncated);
            setSearchHits([]);
            setSearchTruncated(false);
          } else {
            const hits = result as SearchHit[];
            setSearchHits(hits);
            // fs_search/ssh_fs_search cap results at NAME_SEARCH_LIMIT without a
            // truncated flag, so infer truncation from hitting the cap exactly.
            setSearchTruncated(hits.length >= NAME_SEARCH_LIMIT);
            setGrepHits([]);
            setGrepTruncated(false);
          }
          setSearchLoading(false);
        })
        .catch(() => {
          if (cancelled) return;
          setSearchHits([]);
          setGrepHits([]);
          setGrepTruncated(false);
          setSearchTruncated(false);
          setSearchError(true);
          setSearchLoading(false);
        });
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [baseDir, searchQuery, searchMode, includeHidden, reloadKey, isRemote, remotePtyId]);

  const canGoUp = currentPath !== "/" && currentPath !== baseDir;
  const dirs = useMemo(() => entries.filter((e) => e.kind === "dir"), [entries]);
  const files = useMemo(() => entries.filter((e) => e.kind !== "dir"), [entries]);
  const isSearching = searchQuery.trim().length > 0;

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

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
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
            padding: "0 8px",
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

      <div style={{ padding: "6px 8px", borderBottom: "1px solid var(--c-border-1)", flexShrink: 0 }}>
        <div className="explorer-search" style={{ background: "var(--c-bg-3)", borderRadius: "var(--r-input)", display: "flex", alignItems: "center", gap: 7, padding: "5px 8px", border: "1px solid transparent", transition: "border-color var(--duration-fast) ease, box-shadow var(--duration-fast) ease" }}>
          <button
            onClick={() => {
              setSearchMode((m) => {
                const next = m === "name" ? "content" : "name";
                lastFileSearchMode = next;
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
            onChange={(e) => setSearchQuery(e.target.value)}
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

      <div key={contentKey} style={{ flex: 1, overflowY: "auto", padding: "6px 8px", animation: !isSearching && navDir ? `${navDir === "in" ? "slideInRight" : "slideInLeft"} var(--duration-normal) var(--ease-out-expo)` : undefined }} className="no-scrollbar scroll-fade-y">
        {isSearching ? (
          searchMode === "content" ? (
            searchLoading ? (
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
                    <div style={{ padding: "3px 8px", display: "flex", alignItems: "center", gap: 6 }}>
                      <FileIcon />
                      <span style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-3)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)" }} title={group.rel}>{compactRelativePath(group.rel)}</span>
                      <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", background: "var(--c-bg-3)", borderRadius: "var(--r-pill)", padding: "0 6px", fontFamily: "var(--font-mono)", minWidth: 18, textAlign: "center", flexShrink: 0 }}>{group.lines.length}</span>
                    </div>
                    {group.lines.map((ln) => (
                      <button
                        key={ln.line}
                        // Local hits jump to the matched line in the external
                        // editor; remote paths mean nothing to a local editor,
                        // so they toggle the inline remote FilePreview instead
                        // (same affordance as remote name-search hits).
                        onClick={() => isRemote
                          ? toggleSearchFile(group.path)
                          : openEditor(group.path, ln.line)}
                        title={isRemote ? group.rel : t("explorer.search_mode.open_at_line", { line: ln.line })}
                        className="hover-bg"
                        style={{ width: "100%", padding: "2px 8px 2px 30px", borderRadius: "var(--r-btn)", border: "none", background: "transparent", cursor: "pointer", display: "flex", alignItems: "flex-start", gap: 8, textAlign: "left", marginBottom: 1 }}
                      >
                        <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-6)", fontFamily: "var(--font-mono)", flexShrink: 0, minWidth: 28, textAlign: "right" }}>{ln.line}</span>
                        <span style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-2)", fontFamily: "var(--font-mono)", whiteSpace: "pre", overflow: "hidden" }}>{ln.text}</span>
                      </button>
                    ))}
                    {isRemote && expandedFile === group.path && (
                      <div style={{ animation: "contentIn var(--duration-normal) var(--ease-out-expo)", overflow: "hidden" }}>
                        <FilePreview filePath={group.path} fileName={group.rel.split("/").pop() ?? group.rel} remotePtyId={remotePtyId} onClose={() => setExpandedFile(null)} />
                      </div>
                    )}
                  </div>
                ))}
                {grepTruncated && <div style={{ padding: "4px 8px", color: "var(--c-text-5)", fontSize: "var(--fs-meta)" }}>{t("explorer.content_truncated")}</div>}
              </>
            )
          ) : (
          searchLoading ? (
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
                        width: "100%", height: 30, padding: "0 8px", borderRadius: "var(--r-btn)", border: "none",
                        background: isExpanded ? "var(--c-accent-bg-light)" : "transparent",
                        cursor: "pointer", display: "flex", alignItems: "center", gap: 6, textAlign: "left", marginBottom: 2,
                      }}
                    >
                      {hit.isDir ? <FolderIcon /> : <FileIcon />}
                      <span style={{ fontSize: "var(--fs-secondary)", color: isExpanded ? "var(--c-text-primary)" : "var(--c-text-2)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)" }} title={hit.rel}>{compactRelativePath(hit.rel)}</span>
                      {hit.isDir && <span style={{ fontSize: 10, color: "var(--c-text-6)", flexShrink: 0 }}>›</span>}
                    </button>
                    {isExpanded && !hit.isDir && (
                      <div style={{ animation: "contentIn var(--duration-normal) var(--ease-out-expo)", overflow: "hidden" }}>
                        <FilePreview filePath={hit.path} fileName={hit.name} remotePtyId={remotePtyId} onClose={() => setExpandedFile(null)} />
                      </div>
                    )}
                  </div>
                );
              })}
              {searchTruncated && <div style={{ padding: "4px 8px", color: "var(--c-text-5)", fontSize: "var(--fs-meta)" }}>{t("explorer.results_truncated")}</div>}
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
                style={{ width: "100%", height: 30, padding: "0 8px", borderRadius: "var(--r-btn)", border: "none", background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, textAlign: "left", marginBottom: 2 }}
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
                      width: "100%", height: 30, padding: "0 8px", borderRadius: "var(--r-btn)", border: "none",
                      background: isExpanded ? "var(--c-accent-bg-light)" : "transparent",
                      cursor: "pointer", display: "flex", alignItems: "center", gap: 6, textAlign: "left", marginBottom: 2,
                    }}
                  >
                    <FileIcon />
                    <span style={{ fontSize: "var(--fs-secondary)", color: isExpanded ? "var(--c-text-primary)" : "var(--c-text-2)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)" }}>{entry.name}</span>
                    <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)", flexShrink: 0, minWidth: 48, textAlign: "right" }}>{formatSize(entry.size)}</span>
                  </button>
                  {isExpanded && (
                    <div style={{ animation: "contentIn var(--duration-normal) var(--ease-out-expo)", overflow: "hidden" }}>
                      <FilePreview filePath={fullPath} fileName={entry.name} remotePtyId={remotePtyId} onClose={() => setExpandedFile(null)} />
                    </div>
                  )}
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
