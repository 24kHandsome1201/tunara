import { useState, type KeyboardEvent, type ReactNode } from "react";
import { CloseIcon, DownloadIcon, PanelIconButton, RefreshIcon, SearchIcon, UploadFolderIcon, UploadIcon } from "../shared";
import { ContextMenu, type MenuEntry } from "../ContextMenu";
import { breadcrumbSegments } from "../lib/breadcrumbs";
import { FileContentIcon, FileNameIcon } from "./icons";

type Translate = (key: string, params?: Record<string, string | number>) => string;

function ExplorerChipButton({
  pressed,
  label,
  title,
  onClick,
  className,
  children,
}: {
  pressed?: boolean;
  label: string;
  title?: string;
  onClick: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={["hover-bg", "explorer-chip-button", className].filter(Boolean).join(" ")}
      aria-pressed={pressed}
      aria-label={label}
      title={title ?? label}
      data-active={pressed ? "true" : "false"}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function PlacesIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M7 3h10a1.5 1.5 0 0 1 1.5 1.5V21l-6.5-3.2L5.5 21V4.5A1.5 1.5 0 0 1 7 3z" />
    </svg>
  );
}

export function ExplorerNav({
  t,
  canGoUp,
  onGoUp,
  currentPath,
  breadcrumbRoot,
  onNavigate,
  onRefresh,
}: {
  t: Translate;
  canGoUp: boolean;
  onGoUp: () => void;
  currentPath: string;
  breadcrumbRoot: string;
  onNavigate: (path: string) => void;
  onRefresh: () => void;
}) {
  return (
    <nav className="explorer-nav" aria-label={t("explorer.chrome.nav")}>
      <PanelIconButton
        onClick={() => { if (canGoUp) onGoUp(); }}
        disabled={!canGoUp}
        aria-disabled={!canGoUp}
        title={t("explorer.go_up")}
        aria-label={t("explorer.go_up")}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="15 18 9 12 15 6" />
        </svg>
      </PanelIconButton>
      <div className="explorer-breadcrumbs" title={currentPath}>
        {breadcrumbSegments(currentPath, breadcrumbRoot).map((seg, idx, arr) => {
          const isCurrent = seg.targetPath === currentPath;
          const showSeparator = idx < arr.length - 1;
          return (
            <span key={`${idx}:${seg.targetPath}`} className="explorer-breadcrumb" data-collapsed={seg.isCollapsed ? "true" : undefined}>
              <button
                type="button"
                onClick={() => {
                  if (isCurrent) return;
                  onNavigate(seg.targetPath);
                }}
                disabled={isCurrent}
                aria-current={isCurrent ? "page" : undefined}
                className={isCurrent ? "explorer-breadcrumb-current" : "hover-bg explorer-breadcrumb-link"}
                title={seg.targetPath}
              >
                {seg.label}
              </button>
              {showSeparator && <span className="explorer-breadcrumb-sep" aria-hidden="true">›</span>}
            </span>
          );
        })}
      </div>
      <PanelIconButton
        onClick={onRefresh}
        title={t("explorer.refresh")}
        aria-label={t("explorer.refresh")}
      >
        <RefreshIcon />
      </PanelIconButton>
    </nav>
  );
}

export function ExplorerSearchRow({
  t,
  searchMode,
  searchQuery,
  onToggleSearchMode,
  onQueryChange,
  onClearQuery,
  onInputKeyDown,
  includeHidden,
  onToggleHidden,
}: {
  t: Translate;
  searchMode: "name" | "content";
  searchQuery: string;
  onToggleSearchMode: () => void;
  onQueryChange: (query: string) => void;
  onClearQuery: () => void;
  onInputKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  includeHidden: boolean;
  onToggleHidden: () => void;
}) {
  return (
    <div className="explorer-search-row" role="search" aria-label={t("explorer.chrome.search")}>
      <div className="explorer-search">
        <button
          type="button"
          onClick={onToggleSearchMode}
          title={searchMode === "name" ? t("explorer.search_mode.switch_to_content") : t("explorer.search_mode.switch_to_name")}
          aria-label={searchMode === "name" ? t("explorer.search_mode.switch_to_content") : t("explorer.search_mode.switch_to_name")}
          aria-pressed={searchMode === "content"}
          className="hover-bg explorer-search-mode"
          data-active={searchMode === "content" ? "true" : "false"}
        >
          {searchMode === "content" ? <FileContentIcon /> : <FileNameIcon />}
        </button>
        <SearchIcon />
        <input
          className="ui-native-control"
          type="text"
          value={searchQuery}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder={searchMode === "content" ? t("explorer.search_placeholder_content") : t("explorer.search_placeholder")}
        />
        {searchQuery && (
          <button
            type="button"
            onClick={onClearQuery}
            className="hover-bg explorer-search-clear"
            title={t("explorer.clear_search")}
            aria-label={t("explorer.clear_search")}
          >
            <CloseIcon size={11} strokeWidth={2.4} />
          </button>
        )}
      </div>
      <ExplorerChipButton
        pressed={includeHidden}
        label={includeHidden ? t("explorer.hide_dotfiles") : t("explorer.show_dotfiles")}
        onClick={onToggleHidden}
      >
        .*
      </ExplorerChipButton>
    </div>
  );
}

export function ExplorerRemoteTools({
  t,
  bindingKey,
  showPlaces,
  followTerminalCwd,
  onToggleFollowCwd,
  isFavorite,
  onToggleFavorite,
  listingRoot,
  homeDir,
  currentPath,
  favoritePaths,
  recentPaths,
  onJumpToPath,
  remoteDisconnected,
  uploadBusy,
  onUploadFile,
  showFolderTransfer,
  onUploadFolder,
  selectedDownloadCount,
  batchDownloadPreparing,
  onDownloadSelected,
  activeTransferNotice,
  onOpenTransfers,
}: {
  t: Translate;
  bindingKey: string;
  showPlaces: boolean;
  followTerminalCwd: boolean;
  onToggleFollowCwd: () => void;
  isFavorite: boolean;
  onToggleFavorite: () => void;
  listingRoot: string;
  homeDir: string | null;
  currentPath: string;
  favoritePaths: readonly string[];
  recentPaths: readonly string[];
  onJumpToPath: (path: string) => void;
  remoteDisconnected: boolean;
  uploadBusy: boolean;
  onUploadFile: () => void;
  showFolderTransfer: boolean;
  onUploadFolder: () => void;
  selectedDownloadCount: number;
  batchDownloadPreparing: boolean;
  onDownloadSelected: () => void;
  activeTransferNotice: number;
  onOpenTransfers: () => void;
}) {
  const [placesMenu, setPlacesMenu] = useState<{ items: MenuEntry[]; position: { x: number; y: number } } | null>(null);
  const hasHome = Boolean(homeDir && homeDir !== listingRoot);

  const openPlaces = (event: { currentTarget: HTMLElement }) => {
    const items: MenuEntry[] = [];
    items.push({ type: "heading", label: t("explorer.paths_locations") });
    items.push({ id: "loc:root", label: t("explorer.go_root"), icon: "folder", action: () => onJumpToPath(listingRoot) });
    if (hasHome && homeDir) {
      items.push({ id: "loc:home", label: t("explorer.go_home"), icon: "folder", action: () => onJumpToPath(homeDir) });
    }
    if (showPlaces) {
      items.push(null);
      items.push({
        id: "action:follow-cwd",
        label: t(followTerminalCwd ? "explorer.follow_cwd_disable" : "explorer.follow_cwd"),
        action: onToggleFollowCwd,
      });
      items.push({
        id: "action:favorite",
        label: t(isFavorite ? "explorer.favorite_remove" : "explorer.favorite_add"),
        icon: "pin",
        action: onToggleFavorite,
      });
    }
    if (favoritePaths.length > 0) {
      items.push({ type: "heading", label: t("explorer.paths_favorites") });
      for (const path of favoritePaths) {
        items.push({ id: `fav:${path}`, label: path, icon: "pin", action: () => onJumpToPath(path) });
      }
    }
    if (recentPaths.length > 0) {
      items.push({ type: "heading", label: t("explorer.paths_recent") });
      for (const path of recentPaths) {
        items.push({ id: `recent:${path}`, label: path, icon: "folder", action: () => onJumpToPath(path) });
      }
    }
    const rect = event.currentTarget.getBoundingClientRect();
    setPlacesMenu({ items, position: { x: rect.left, y: rect.bottom + 4 } });
  };

  return (
    <div className="explorer-tools" role="toolbar" aria-label={t("explorer.chrome.tools")}>
      <div className="explorer-places" role="group" aria-label={t("explorer.chrome.places")}>
        <ExplorerChipButton
          pressed={currentPath === listingRoot}
          label={t("explorer.go_root")}
          onClick={() => onJumpToPath(listingRoot)}
          className="explorer-place-shortcut"
        >
          /
        </ExplorerChipButton>
        {hasHome && homeDir && (
          <ExplorerChipButton
            pressed={currentPath === homeDir}
            label={t("explorer.go_home")}
            onClick={() => onJumpToPath(homeDir)}
            className="explorer-place-shortcut"
          >
            ~
          </ExplorerChipButton>
        )}
        {showPlaces && (
          <>
            <ExplorerChipButton
              pressed={followTerminalCwd}
              label={t("explorer.follow_cwd")}
              title={t(followTerminalCwd ? "explorer.follow_cwd_on" : "explorer.follow_cwd")}
              onClick={onToggleFollowCwd}
              className="explorer-place-secondary"
            >
              cwd
            </ExplorerChipButton>
            <PanelIconButton
              title={isFavorite ? t("explorer.favorite_remove") : t("explorer.favorite_add")}
              aria-label={isFavorite ? t("explorer.favorite_remove") : t("explorer.favorite_add")}
              data-active={isFavorite ? "true" : "false"}
              onClick={onToggleFavorite}
              className="explorer-place-secondary"
              style={isFavorite ? { color: "var(--c-accent)" } : undefined}
            >
              ★
            </PanelIconButton>
          </>
        )}
        <PanelIconButton
          title={t("explorer.paths")}
          aria-label={t("explorer.paths")}
          aria-haspopup="menu"
          aria-expanded={placesMenu !== null}
          onClick={(event) => openPlaces(event)}
        >
          <PlacesIcon />
        </PanelIconButton>
      </div>
      <div className="explorer-transfers" role="group" aria-label={t("explorer.chrome.transfers")}>
        <PanelIconButton
          onClick={onUploadFile}
          disabled={remoteDisconnected || uploadBusy}
          title={t("explorer.upload")}
          aria-label={t("explorer.upload")}
        >
          <UploadIcon />
        </PanelIconButton>
        {showFolderTransfer && (
          <>
            <PanelIconButton
              onClick={onUploadFolder}
              disabled={remoteDisconnected}
              title={t("explorer.upload_folder")}
              aria-label={t("explorer.upload_folder")}
            >
              <UploadFolderIcon />
            </PanelIconButton>
            <PanelIconButton
              onClick={onDownloadSelected}
              disabled={remoteDisconnected || selectedDownloadCount === 0 || batchDownloadPreparing}
              title={t("explorer.download.batch_action", { count: selectedDownloadCount })}
              aria-label={t("explorer.download.batch_action", { count: selectedDownloadCount })}
              data-active={selectedDownloadCount > 0 ? "true" : "false"}
              className={selectedDownloadCount > 0 ? "explorer-download-armed" : undefined}
            >
              <DownloadIcon />
              {selectedDownloadCount > 0 && (
                <span aria-hidden="true" className="explorer-download-count">{selectedDownloadCount}</span>
              )}
            </PanelIconButton>
          </>
        )}
        {activeTransferNotice > 0 && (
          <button
            type="button"
            onClick={onOpenTransfers}
            className="hover-bg explorer-transfer-entry"
            title={t("explorer.transfers_open")}
            aria-label={t("explorer.transfers_in_progress", { count: String(activeTransferNotice) })}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M7 7h11" />
              <path d="m15 4 3 3-3 3" />
              <path d="M17 17H6" />
              <path d="m9 14-3 3 3 3" />
            </svg>
            <span aria-hidden="true" className="explorer-transfer-count">
              {activeTransferNotice > 99 ? "99+" : activeTransferNotice}
            </span>
          </button>
        )}
      </div>
      {placesMenu && (
        <ContextMenu
          items={placesMenu.items}
          position={placesMenu.position}
          bindingKey={bindingKey}
          currentBindingKey={bindingKey}
          onClose={() => setPlacesMenu(null)}
        />
      )}
    </div>
  );
}
