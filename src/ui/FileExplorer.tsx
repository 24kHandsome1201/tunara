import { useEffect, useMemo, useState } from "react";
import { fsReadDir, fsSearch, type DirEntry, type SearchHit } from "@/modules/fs/fs-bridge";
import { formatSize } from "./types";
import { FilePreview } from "./FilePreview";
import { CloseIcon, RefreshIcon, SearchIcon, PanelEmptyState, PanelLoadingState } from "./shared";
import { ContextMenu, type MenuEntry } from "./ContextMenu";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { openInEditor } from "@/modules/editor/open";
import { useT } from "@/modules/i18n";

interface FileExplorerProps {
  rootDir: string;
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

function pathDisplay(currentPath: string, rootDir: string): string {
  if (currentPath === rootDir) return rootDir;
  let display = currentPath;
  if (rootDir !== "/" && currentPath.startsWith(rootDir + "/")) {
    display = currentPath.slice(rootDir.length + 1).split("/").join(" › ");
  }
  const parts = display.split(/[\/›]/).map((part) => part.trim()).filter(Boolean);
  if (parts.length <= 4) return parts.join(" › ") || "/";
  return "… › " + parts.slice(-4).join(" › ");
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

export function FileExplorer({ rootDir }: FileExplorerProps) {
  const t = useT();
  const [currentPath, setCurrentPath] = useState(rootDir);
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
  const [contextMenu, setContextMenu] = useState<{
    items: MenuEntry[];
    position: { x: number; y: number };
  } | null>(null);
  const externalEditor = useUIStore((s) => s.externalEditor);

  useEffect(() => {
    setNavDir(null);
    setCurrentPath(rootDir);
    setExpandedFile(null);
    setSearchQuery("");
  }, [rootDir]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    setExpandedFile(null);
    fsReadDir(currentPath, includeHidden)
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
  }, [currentPath, includeHidden, reloadKey]);

  useEffect(() => {
    const q = searchQuery.trim();
    if (!q) {
      setSearchHits([]);
      setSearchLoading(false);
      setSearchError(false);
      return;
    }

    let cancelled = false;
    setSearchLoading(true);
    setSearchError(false);
    const timer = window.setTimeout(() => {
      fsSearch(rootDir, q, 80, includeHidden)
        .then((hits) => {
          if (!cancelled) {
            setSearchHits(hits);
            setSearchLoading(false);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setSearchHits([]);
            setSearchError(true);
            setSearchLoading(false);
          }
        });
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [rootDir, searchQuery, includeHidden, reloadKey]);

  const canGoUp = currentPath !== "/" && currentPath !== rootDir;
  const dirs = useMemo(() => entries.filter((e) => e.kind === "dir"), [entries]);
  const files = useMemo(() => entries.filter((e) => e.kind !== "dir"), [entries]);
  const isSearching = searchQuery.trim().length > 0;

  function refresh() {
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
          onClick={goUp}
          disabled={!canGoUp}
          className="hover-bg"
          title="返回上级"
          aria-label="返回上级"
          style={{
            width: 26, height: 26, borderRadius: "var(--r-btn)", border: "none",
            background: "transparent", cursor: canGoUp ? "pointer" : "default",
            display: "flex", alignItems: "center", justifyContent: "center",
            opacity: canGoUp ? 1 : 0.3, flexShrink: 0,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span title={currentPath} style={{ fontSize: "var(--fs-meta)", lineHeight: "16px", fontFamily: "var(--font-mono)", color: "var(--c-text-4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0, padding: "0 var(--sp-1)" }}>
          {pathDisplay(currentPath, rootDir)}
        </span>
        <button
          onClick={refresh}
          className="hover-bg"
          title="刷新文件列表"
          aria-label="刷新文件列表"
          style={{ width: 26, height: 26, borderRadius: "var(--r-btn)", border: "none", background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
        >
          <RefreshIcon />
        </button>
        <button
          onClick={() => setIncludeHidden((v) => !v)}
          className="hover-bg"
          title={includeHidden ? "隐藏点文件" : "显示点文件"}
          aria-label={includeHidden ? "隐藏点文件" : "显示点文件"}
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
          <SearchIcon />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索当前项目"
            style={{ flex: 1, border: "none", background: "transparent", outline: "none", fontSize: "var(--fs-secondary)", color: "var(--c-text-primary)", fontFamily: "var(--font-ui)", minWidth: 0 }}
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="hover-bg"
              title="清空搜索"
              style={{ width: 18, height: 18, borderRadius: "var(--r-btn)", border: "none", background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--c-text-5)", flexShrink: 0 }}
            >
              <CloseIcon size={11} strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>

      <div key={contentKey} style={{ flex: 1, overflowY: "auto", padding: "6px 8px", animation: !isSearching && navDir ? `${navDir === "in" ? "slideInRight" : "slideInLeft"} var(--duration-normal) var(--ease-out-expo)` : undefined }} className="no-scrollbar scroll-fade-y">
        {isSearching ? (
          searchLoading ? (
            <PanelLoadingState label="搜索中" />
          ) : searchError ? (
            <PanelEmptyState label="搜索失败" sublabel={searchQuery.trim()} />
          ) : searchHits.length === 0 ? (
            <PanelEmptyState label="没有找到匹配文件" sublabel={searchQuery.trim()} />
          ) : (
            <>
              <div style={{ padding: "3px 6px 7px", display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: "var(--fs-meta)", lineHeight: "16px", color: "var(--c-text-5)", fontFamily: "var(--font-mono)" }}>结果</span>
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
                        <FilePreview filePath={hit.path} fileName={hit.name} onClose={() => setExpandedFile(null)} />
                      </div>
                    )}
                  </div>
                );
              })}
            </>
          )
        ) : loading ? (
          <PanelLoadingState />
        ) : error ? (
          <PanelEmptyState label="无法读取目录" sublabel={currentPath} />
        ) : entries.length === 0 ? (
          <PanelEmptyState icon={folderEmptyIcon} label="目录为空" />
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
                    items: [
                      { id: "dir:new-terminal", label: t("sidebar.dir.new_terminal"), icon: "terminal", action: () => useSessionsStore.getState().newTerminalInDir(fullPath) },
                      { id: "dir:open-editor", label: t("sidebar.dir.open_in_editor"), icon: "editor", action: () => { openInEditor(externalEditor, fullPath).catch(() => {}); } },
                      { id: "dir:copy-path", label: t("sidebar.dir.copy_path"), icon: "copy", action: () => { navigator.clipboard.writeText(fullPath).catch(() => {}); } },
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
                        items: [
                          { id: "file:open-editor", label: t("sidebar.dir.open_in_editor"), icon: "editor", action: () => { openInEditor(externalEditor, fullPath).catch(() => {}); } },
                          { id: "file:copy-path", label: t("sidebar.dir.copy_path"), icon: "copy", action: () => { navigator.clipboard.writeText(fullPath).catch(() => {}); } },
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
                      <FilePreview filePath={fullPath} fileName={entry.name} onClose={() => setExpandedFile(null)} />
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
