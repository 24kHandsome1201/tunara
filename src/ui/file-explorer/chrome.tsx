import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { CloseIcon, PanelIconButton, RefreshIcon, SearchIcon, UploadIcon } from "../shared";
import { ContextMenu, type MenuEntry } from "../ContextMenu";
import { breadcrumbSegments } from "../lib/breadcrumbs";
import { FileContentIcon, FileNameIcon } from "./icons";
import { ArrowLeft, ArrowRight, ArrowsDownUp, BookmarkSimple, DotsThree, Icon, PencilSimple } from "@/ui/icons";

type Translate = (key: string, params?: Record<string, string | number>) => string;

function ExplorerChipButton({
  pressed,
  disabled,
  label,
  onClick,
  children,
}: {
  pressed?: boolean;
  disabled?: boolean;
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="hover-bg explorer-chip-button"
      aria-pressed={pressed}
      disabled={disabled}
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
  disabled,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward,
  currentPath,
  breadcrumbRoot,
  breadcrumbHome,
  onNavigate,
  onRefresh,
}: {
  t: Translate;
  disabled: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  onGoBack: () => void;
  onGoForward: () => void;
  currentPath: string;
  breadcrumbRoot: string;
  breadcrumbHome: string | null;
  onNavigate: (path: string, direction?: "in" | "out") => void;
  onRefresh: () => void;
}) {
  const [draft, setDraft] = useState<{ path: string; origin: string; invalid: boolean } | null>(null);
  const editing = !disabled && draft?.origin === currentPath;
  const inputRef = useRef<HTMLInputElement>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const errorId = useId();
  useLayoutEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);
  useEffect(() => {
    setDraft(null);
  }, [currentPath, disabled]);

  function finishEditing() {
    setDraft(null);
    editButtonRef.current?.focus();
  }

  return (
    <>
      <nav className="explorer-nav" aria-label={t("explorer.chrome.nav")}>
        <PanelIconButton
          onClick={onGoBack}
          disabled={disabled || !canGoBack}
          title={t("explorer.go_back")}
        >
          <Icon icon={ArrowLeft} size={14} />
        </PanelIconButton>
        <PanelIconButton
          onClick={onGoForward}
          disabled={disabled || !canGoForward}
          title={t("explorer.go_forward")}
        >
          <Icon icon={ArrowRight} size={14} />
        </PanelIconButton>
        {editing ? (
          <input
            ref={inputRef}
            className="ui-native-control explorer-path-input"
            aria-label={t("explorer.directory_path")}
            aria-invalid={draft.invalid || undefined}
            aria-describedby={draft.invalid ? errorId : undefined}
            spellCheck={false}
            value={draft.path}
            onChange={(event) => setDraft({ ...draft, path: event.target.value, invalid: false })}
            onBlur={(event) => {
              if (event.relatedTarget !== editButtonRef.current) setDraft(null);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || (event.key !== "Enter" && event.key !== "Escape")) return;
              event.preventDefault();
              event.stopPropagation();
              if (event.key === "Escape") {
                finishEditing();
                return;
              }
              if (!draft.path.startsWith("/") || draft.path.includes("\0") || /(?:^|\/)\.{1,2}(?:\/|$)/.test(draft.path)) {
                setDraft({ ...draft, invalid: true });
                return;
              }
              finishEditing();
              onNavigate(draft.path.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/");
            }}
          />
        ) : <div className="explorer-breadcrumbs" title={currentPath}>
          {breadcrumbSegments(currentPath, breadcrumbRoot, breadcrumbHome).map((seg, idx, arr) => {
            const isCurrent = seg.targetPath === currentPath;
            const showSeparator = idx < arr.length - 1;
            return (
              <span key={`${idx}:${seg.targetPath}`} className="explorer-breadcrumb" data-collapsed={seg.isCollapsed ? "true" : undefined}>
                <button
                  type="button"
                  onClick={() => {
                    if (isCurrent) return;
                    onNavigate(seg.targetPath, "out");
                  }}
                  disabled={disabled || isCurrent}
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
        </div>}
        <PanelIconButton
          ref={editButtonRef}
          disabled={disabled || !currentPath.startsWith("/")}
          onClick={() => {
            if (editing) finishEditing();
            else setDraft({ path: currentPath, origin: currentPath, invalid: false });
          }}
          aria-pressed={editing}
          title={t("explorer.edit_path")}
        >
          <Icon icon={PencilSimple} size={14} />
        </PanelIconButton>
        <PanelIconButton
          disabled={disabled}
          onClick={onRefresh}
          title={t("explorer.refresh")}
          aria-label={t("explorer.refresh")}
        >
          <RefreshIcon />
        </PanelIconButton>
      </nav>
      {editing && draft.invalid && (
        <div id={errorId} role="alert" className="explorer-error-notice">{t("explorer.path_absolute_required")}</div>
      )}
    </>
  );
}

export function ExplorerSearchRow({
  t,
  disabled,
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
  disabled: boolean;
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
          disabled={disabled}
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
          disabled={disabled}
          value={searchQuery}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={onInputKeyDown}
          placeholder={searchMode === "content" ? t("explorer.search_placeholder_content") : t("explorer.search_placeholder")}
          aria-label={searchMode === "content" ? t("explorer.search_placeholder_content") : t("explorer.search_placeholder")}
        />
        {searchQuery && (
          <button
            type="button"
            disabled={disabled}
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
        disabled={disabled}
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
  active,
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
  downloadSelectionUnavailable,
  onToggleSelectionMode,
  selectedDownloadCount,
  batchDownloadPreparing,
  onDownloadSelected,
  activeTransferNotice,
  onOpenTransfers,
}: {
  t: Translate;
  active: boolean;
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
  downloadSelectionUnavailable: boolean;
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
  useEffect(() => () => setMenu(null), []);
  const hasHome = Boolean(homeDir && homeDir !== listingRoot);

  function moreItems(): MenuEntry[] {
    const items: MenuEntry[] = [
      { id: "loc:root", label: t("explorer.go_root"), icon: "folder", disabled: remoteDisconnected, action: () => onJumpToPath(listingRoot) },
    ];
    if (hasHome && homeDir) {
      items.push({ id: "loc:home", label: t("explorer.go_home"), icon: "folder", disabled: remoteDisconnected, action: () => onJumpToPath(homeDir) });
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
        disabled: remoteDisconnected || downloadSelectionUnavailable || selectedDownloadCount === 0 || batchDownloadPreparing,
        action: onDownloadSelected,
      }, {
        id: "action:select",
        label: t(selectionMode ? "explorer.download.exit_selection" : "explorer.download.enter_selection"),
        disabled: remoteDisconnected || downloadSelectionUnavailable,
        action: onToggleSelectionMode,
      });
    }
    return items;
  }

  function favoriteItems(): MenuEntry[] {
    const items: MenuEntry[] = [{ type: "heading", label: t("explorer.paths_favorites") }];
    for (const path of favoritePaths) {
      items.push({ id: `fav:${path}`, label: path, icon: "pin", disabled: remoteDisconnected, action: () => onJumpToPath(path) });
    }
    if (favoritePaths.length === 0) {
      items.push({ id: "fav:empty", label: t("explorer.paths_no_favorites"), disabled: true, action: () => {} });
    }
    if (recentPaths.length > 0) {
      items.push({ type: "heading", label: t("explorer.paths_recent") });
      for (const path of recentPaths) {
        items.push({ id: `recent:${path}`, label: path, icon: "folder", disabled: remoteDisconnected, action: () => onJumpToPath(path) });
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
      {active && menu && (
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
