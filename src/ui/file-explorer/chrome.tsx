import { useState, type KeyboardEvent, type ReactNode } from "react";
import { CloseIcon, PanelIconButton, RefreshIcon, SearchIcon, UploadIcon } from "../shared";
import { ContextMenu, type MenuEntry } from "../ContextMenu";
import { breadcrumbSegments } from "../lib/breadcrumbs";
import { FileContentIcon, FileNameIcon } from "./icons";
import { ArrowsDownUp, BookmarkSimple, CaretLeft, DotsThree, Icon } from "@/ui/icons";

type Translate = (key: string, params?: Record<string, string | number>) => string;

function ExplorerChipButton({
  pressed,
  label,
  onClick,
  children,
}: {
  pressed?: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="hover-bg explorer-chip-button"
      aria-pressed={pressed}
      aria-label={label}
      title={label}
      data-active={pressed ? "true" : "false"}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function PlacesIcon() {
  return <Icon icon={BookmarkSimple} size={14} />;
}

export function ExplorerNav({
  t,
  canGoUp,
  onGoUp,
  currentPath,
  breadcrumbRoot,
  breadcrumbHome,
  onNavigate,
  onRefresh,
}: {
  t: Translate;
  canGoUp: boolean;
  onGoUp: () => void;
  currentPath: string;
  breadcrumbRoot: string;
  breadcrumbHome: string | null;
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
        <Icon icon={CaretLeft} size={14} />
      </PanelIconButton>
      <div className="explorer-breadcrumbs" title={currentPath}>
        {breadcrumbSegments(currentPath, breadcrumbRoot, breadcrumbHome).map((seg, idx, arr) => {
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
          aria-label={searchMode === "content" ? t("explorer.search_placeholder_content") : t("explorer.search_placeholder")}
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
  favoritePaths,
  recentPaths,
  onJumpToPath,
  remoteDisconnected,
  uploadBusy,
  onUploadFile,
  showFolderTransfer,
  onUploadFolder,
  selectionMode,
  onToggleSelectionMode,
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
  favoritePaths: readonly string[];
  recentPaths: readonly string[];
  onJumpToPath: (path: string) => void;
  remoteDisconnected: boolean;
  uploadBusy: boolean;
  onUploadFile: () => void;
  showFolderTransfer: boolean;
  onUploadFolder: () => void;
  selectionMode: boolean;
  onToggleSelectionMode: () => void;
  selectedDownloadCount: number;
  batchDownloadPreparing: boolean;
  onDownloadSelected: () => void;
  activeTransferNotice: number;
  onOpenTransfers: () => void;
}) {
  const [menu, setMenu] = useState<{
    kind: "places" | "more";
    bindingKey: string;
    trigger: HTMLElement;
    position: { x: number; y: number };
  } | null>(null);
  const hasHome = Boolean(homeDir && homeDir !== listingRoot);

  function moreItems(): MenuEntry[] {
    const items: MenuEntry[] = [
      { id: "loc:root", label: t("explorer.go_root"), icon: "folder", action: () => onJumpToPath(listingRoot) },
    ];
    if (hasHome && homeDir) {
      items.push({ id: "loc:home", label: t("explorer.go_home"), icon: "folder", action: () => onJumpToPath(homeDir) });
    }
    if (showPlaces) {
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
    if (showFolderTransfer) {
      items.push(null, {
        id: "transfer:upload-folder",
        label: t("explorer.upload_folder"),
        icon: "upload-folder",
        disabled: remoteDisconnected,
        action: onUploadFolder,
      }, {
        id: "transfer:download-selected",
        label: t("explorer.download.batch_action", { count: selectedDownloadCount }),
        icon: "download",
        disabled: remoteDisconnected || selectedDownloadCount === 0 || batchDownloadPreparing,
        action: onDownloadSelected,
      }, {
        id: "action:select",
        label: t(selectionMode ? "explorer.download.exit_selection" : "explorer.download.enter_selection"),
        disabled: remoteDisconnected,
        action: onToggleSelectionMode,
      });
    }
    return items;
  }

  function favoriteItems(): MenuEntry[] {
    const items: MenuEntry[] = [{ type: "heading", label: t("explorer.paths_favorites") }];
    for (const path of favoritePaths) {
      items.push({ id: `fav:${path}`, label: path, icon: "pin", action: () => onJumpToPath(path) });
    }
    if (favoritePaths.length === 0) {
      items.push({ id: "fav:empty", label: t("explorer.paths_no_favorites"), disabled: true, action: () => {} });
    }
    if (recentPaths.length > 0) {
      items.push({ type: "heading", label: t("explorer.paths_recent") });
      for (const path of recentPaths) {
        items.push({ id: `recent:${path}`, label: path, icon: "folder", action: () => onJumpToPath(path) });
      }
    }
    return items;
  }

  function openMenu(kind: "places" | "more", trigger: HTMLElement) {
    const rect = trigger.getBoundingClientRect();
    setMenu({ kind, bindingKey, trigger, position: { x: rect.left, y: rect.bottom + 4 } });
  }

  return (
    <div className="explorer-tools" role="toolbar" aria-label={t("explorer.chrome.tools")}>
      <div className="explorer-places" role="group" aria-label={t("explorer.chrome.places")}>
        <PanelIconButton
          title={t("explorer.paths")}
          aria-label={t("explorer.paths")}
          aria-haspopup="menu"
          aria-expanded={menu?.kind === "places"}
          onClick={(event) => openMenu("places", event.currentTarget)}
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
        {activeTransferNotice > 0 && (
          <button
            type="button"
            onClick={onOpenTransfers}
            className="hover-bg explorer-transfer-entry"
            title={t("explorer.transfers_open")}
            aria-label={t("explorer.transfers_in_progress", { count: String(activeTransferNotice) })}
          >
            <Icon icon={ArrowsDownUp} size={14} />
            <span aria-hidden="true" className="explorer-transfer-count">
              {activeTransferNotice > 99 ? "99+" : activeTransferNotice}
            </span>
          </button>
        )}
      </div>
      <PanelIconButton
        title={t("explorer.more_actions")}
        aria-haspopup="menu"
        aria-expanded={menu?.kind === "more"}
        data-active={selectionMode ? "true" : undefined}
        onClick={(event) => openMenu("more", event.currentTarget)}
      >
        <Icon icon={DotsThree} size={16} weight="bold" />
      </PanelIconButton>
      {menu && (
        <ContextMenu
          key={menu.kind}
          items={menu.kind === "places" ? favoriteItems() : moreItems()}
          position={menu.position}
          bindingKey={menu.bindingKey}
          currentBindingKey={bindingKey}
          returnFocusToken={menu.trigger}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
