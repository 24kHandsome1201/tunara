import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

test("node test script can import TypeScript sources on Node 22", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.match(pkg.scripts["test:node"], /--experimental-strip-types/);
  assert.match(pkg.scripts.test, /pnpm test:node/);
});

test("release metadata keeps versions and distribution identifiers aligned", () => {
  const pkg = JSON.parse(read("package.json"));
  const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
  const cargo = read("src-tauri/Cargo.toml");
  const lock = read("src-tauri/Cargo.lock");
  const cask = read("homebrew/conduit.rb");

  const version = pkg.version;
  assert.equal(tauri.version, version);
  assert.match(cargo, new RegExp(`^version = "${version}"$`, "m"));
  assert.match(lock, new RegExp(`name = "conduit"\\nversion = "${version}"`));
  assert.match(cask, new RegExp(`version "${version}"`));

  assert.equal(tauri.identifier, "dev.conduit.app");
  assert.match(cask, /github\.com\/24kHandsome1201\/conduit/);
  assert.doesNotMatch(cask, /github\.com\/mawei\/conduit/);
  assert.doesNotMatch(cask, /PLACEHOLDER_SHA256/);
  assert.doesNotMatch(cask, /com\.conduit\.app/);
  assert.match(cask, /Application Support\/dev\.conduit\.app/);
  assert.match(tauri.plugins.updater.endpoints[0], /github\.com\/24kHandsome1201\/conduit/);
});

test("session persistence keeps custom titles and rejects invalid stored payloads", () => {
  const persist = read("src/state/persist.ts");
  assert.match(persist, /function isPersistedSession\(value: unknown\): value is PersistedSession/);
  assert.match(persist, /title: p\.title\.trim\(\) \|\| "终端"/);
  assert.match(persist, /store\.get<unknown>\(SESSIONS_KEY\)/);
  assert.match(persist, /persisted\.filter\(isPersistedSession\)/);
  assert.match(persist, /typeof activeId === "string" \? activeId : null/);
  assert.match(persist, /function isPersistedUILayout\(value: unknown\): value is PersistedUILayout/);
});

test("drag and resize handlers release pointer capture from the original handle", () => {
  for (const path of ["src/app/App.tsx", "src/ui/Sidebar.tsx"]) {
    const source = read(path);
    assert.match(source, /e\.currentTarget as HTMLElement/);
    assert.match(source, /hasPointerCapture\(ev\.pointerId\)/);
    assert.match(source, /releasePointerCapture\(ev\.pointerId\)/);
    assert.match(source, /document\.addEventListener\("pointercancel"/);
    assert.doesNotMatch(source, /ev\.target as HTMLElement\)\.releasePointerCapture/);
    assert.doesNotMatch(source, /e\.target as HTMLElement\)\.setPointerCapture/);
  }
});

test("app shell keeps shared resize and window lifecycle plumbing centralized", () => {
  const app = read("src/app/App.tsx");
  const init = read("src/app/useInit.ts");

  assert.match(app, /interface ResizeHandleProps/);
  assert.match(app, /function ResizeHandle\(\{ edge, getWidth, setWidth, direction, className \}: ResizeHandleProps\)/);
  assert.match(app, /<ResizeHandle[\s\S]*edge="left"[\s\S]*direction=\{-1\}/);
  assert.match(app, /<ResizeHandle[\s\S]*edge="right"[\s\S]*direction=\{1\}/);
  assert.doesNotMatch(app, /function PanelResizeHandle\(\)[\s\S]*?document\.addEventListener\("pointermove"/);
  assert.doesNotMatch(app, /function SidebarResizeHandle\(\)[\s\S]*?document\.addEventListener\("pointermove"/);

  assert.match(init, /const win = getCurrentWindow\(\);/);
  assert.match(init, /win\.isFullscreen\(\)/);
  assert.match(init, /win\.onCloseRequested/);
  assert.equal((init.match(/getCurrentWindow\(\)/g) ?? []).length, 1);
});

test("file explorer exposes fast project search, refresh, and hidden-file controls", () => {
  const bridge = read("src/modules/fs/fs-bridge.ts");
  const explorer = read("src/ui/FileExplorer.tsx");
  const search = read("src-tauri/src/modules/fs/search.rs");
  const tree = read("src-tauri/src/modules/fs/tree.rs");

  assert.match(bridge, /export interface SearchHit/);
  assert.match(bridge, /fsReadDir\(path: string, includeHidden = false\)/);
  assert.match(bridge, /fsSearch\([\s\S]*includeHidden = false/);
  assert.match(explorer, /fsSearch\(rootDir, q, 80, includeHidden\)/);
  assert.match(explorer, /setReloadKey\(\(n\) => n \+ 1\)/);
  assert.match(explorer, /setIncludeHidden\(\(v\) => !v\)/);
  assert.match(explorer, /placeholder="搜索当前项目"/);
  assert.match(search, /#\[serde\(rename_all = "camelCase"\)\]/);
  assert.match(search, /include_hidden: Option<bool>/);
  assert.match(search, /\.hidden\(!include_hidden\)/);
  assert.match(tree, /include_hidden: Option<bool>/);
});

test("git sidebar state is single-sourced and distinguishes non-repo directories", () => {
  const types = read("src/ui/types.ts");
  const main = read("src/ui/MainArea.tsx");
  const diff = read("src/ui/DiffPanel.tsx");
  const lifecycle = read("src/modules/terminal/lib/session-lifecycle.ts");

  assert.match(types, /export type GitState = "unknown" \| "repo" \| "notGit";/);
  assert.match(types, /gitState\?: GitState;/);
  assert.match(main, /gitState: "repo"/);
  assert.match(main, /gitState: "notGit"/);
  assert.match(lifecycle, /gitState: "unknown"/);
  assert.match(diff, /session\.changes\?\.files \?\? \[\]/);
  assert.match(diff, /session\.gitState === "notGit"/);
  assert.match(diff, /useSessionsStore\.getState\(\)\.refreshGit\(session\.id\)/);
  assert.doesNotMatch(diff, /\bgitStatus\b/);
});

test("session persistence is debounced and still flushed on close", () => {
  const init = read("src/app/useInit.ts");
  assert.match(init, /let saveTimer: ReturnType<typeof setTimeout> \| null = null/);
  assert.match(init, /const scheduleSessionsSave = \(\) => \{/);
  assert.match(init, /setTimeout\(\(\) => \{[\s\S]*?persistSessionsNow\(\);[\s\S]*?\}, 500\)/);
  assert.match(init, /scheduleSessionsSave\(\);/);
  assert.match(init, /const timer = setInterval\(persistSessionsNow, 30_000\);/);
  assert.match(init, /onCloseRequested\(async \(\) => \{[\s\S]*?clearTimeout\(saveTimer\);[\s\S]*?await saveSessions/);
});

test("responsive shells close cleanly and avoid stale remote git badges", () => {
  const app = read("src/app/App.tsx");
  const keys = read("src/app/useKeybindings.ts");
  const main = read("src/ui/MainArea.tsx");
  const settings = read("src/ui/overlays/Settings.tsx");

  assert.match(app, /const sidebarEffectiveWidth = sidebarVisible/);
  assert.match(app, /const panelEffectiveWidth = panelVisible/);
  assert.match(app, /onClick=\{togglePanel\}/);
  assert.match(app, /onClick=\{toggleSidebar\}/);
  assert.match(keys, /if \(e\.key === "Escape"\)/);
  assert.match(keys, /ui\.setOverlay\(null\)/);
  assert.match(keys, /ui\.setSidebarVisible\(false\)/);
  assert.match(keys, /ui\.setPanelVisible\(false\)/);
  assert.match(keys, /const \{ paneA, paneB \} = ui\.split/);
  assert.match(keys, /st\.setActive\(st\.activeSessionId === paneB \? paneA : paneB\)/);
  assert.match(main, /setRemote\(null\);[\s\S]*gitAheadBehind\(active\.dir\)/);
  assert.match(settings, /maxWidth: "calc\(100vw - 32px\)"/);
});

test("session store keeps active sessions visible in split mode and cleans per-session metadata", () => {
  const source = read("src/state/sessions.ts");
  const init = read("src/app/useInit.ts");

  assert.match(source, /function ensureSessionVisibleInSplit\(sessionId: string\)/);
  assert.match(source, /ui\.setSplitPaneB\(sessionId\)/);
  assert.match(source, /ensureSessionVisibleInSplit\(s\.id\)/);
  assert.match(source, /if \(accepted\) ensureSessionVisibleInSplit\(id\);/);
  assert.match(source, /const \{ \[id\]: _gitNonce, \.\.\.gitNonce \} = state\.gitNonce;/);
  assert.match(source, /sessions\[Math\.min\(Math\.max\(removedIndex, 0\), sessions\.length - 1\)\]/);
  assert.match(init, /const merged = current\.sessions\.length === 0/);
  assert.match(init, /ui\.setSidebarVisible\(layout\.sidebarVisible\)/);
  assert.match(init, /ui\.setPanelVisible\(layout\.panelVisible\)/);
});

test("file previews and markdown rendering stay bounded", () => {
  const rust = read("src-tauri/src/modules/fs/file.rs");
  const bridge = read("src/modules/fs/fs-bridge.ts");
  const preview = read("src/ui/FilePreview.tsx");
  const git = read("src-tauri/src/modules/git/mod.rs");

  assert.match(rust, /const MAX_TEXT_PREVIEW_BYTES: u64 = 256 \* 1024/);
  assert.match(rust, /truncated: bool/);
  assert.match(rust, /take\(MAX_TEXT_PREVIEW_BYTES \+ 1\)/);
  assert.match(rust, /bytes\.truncate\(MAX_TEXT_PREVIEW_BYTES as usize\)/);
  assert.match(bridge, /truncated\?: boolean/);
  assert.match(preview, /useMemo/);
  assert.match(preview, /result\.truncated \? "\\n… 已截断" : ""/);
  assert.match(git, /out\.len\(\) \+ content\.len\(\) \+ prefix_len > DIFF_MAX_BYTES/);
});

test("appearance settings are sanitized and command palette exposes useful actions", () => {
  const ui = read("src/state/ui.ts");
  const palette = read("src/ui/overlays/CommandPalette.tsx");
  const sidebar = read("src/ui/Sidebar.tsx");
  const toast = read("src/ui/Toast.tsx");
  const css = read("src/styles/globals.css");

  assert.match(ui, /function clampNumber\(value: unknown/);
  assert.match(ui, /function sanitizeAccent\(value: unknown\)/);
  assert.match(ui, /setAccent: \(accent\) => set\(\{ accent: sanitizeAccent\(accent\) \}\)/);
  assert.match(ui, /setSidebarVisible: \(sidebarVisible\) => set\(\{ sidebarVisible \}\)/);
  assert.match(ui, /setPanelVisible: \(panelVisible\) => set\(\{ panelVisible \}\)/);
  assert.match(ui, /setExternalEditor: \(externalEditor\) => set\(\{ externalEditor: isExternalEditor\(externalEditor\)/);
  assert.match(palette, /label: "在当前目录新建终端"/);
  assert.match(palette, /label: "刷新当前 Git 状态"/);
  assert.match(palette, /label: "关闭当前会话"/);
  assert.match(palette, /ranked\.length === 0 \? 0 : Math\.min\(index, ranked\.length - 1\)/);
  assert.match(palette, /for \(const \[globalIdx, cmd\] of ranked\.entries\(\)\)/);
  assert.doesNotMatch(palette, /ranked\.indexOf/);
  assert.match(sidebar, /const canReorder = q\.length === 0/);
  assert.match(sidebar, /if \(!canReorder\) return;/);
  assert.match(toast, /exitTimerRef/);
  assert.match(toast, /minWidth: 260/);
  assert.match(toast, /maxWidth: "min\(340px, calc\(100vw - 24px\)\)"/);
  assert.match(toast, /boxShadow: `var\(--shadow-notif\), inset 3px 0 0 \$\{accentColor\}`/);
  assert.doesNotMatch(toast, /width: 260/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});

test("review fixes remove stale artifacts and guard high-risk regressions", () => {
  const html = read("index.html");
  const sessionCard = read("src/ui/SessionCard.tsx");
  const editor = read("src-tauri/src/modules/editor/mod.rs");
  const terminal = read("src/ui/TerminalView.tsx");
  const status = read("src/ui/AgentStatusBar.tsx");
  const sidebar = read("src/ui/Sidebar.tsx");
  const explorer = read("src/ui/FileExplorer.tsx");
  const sessions = read("src/state/sessions.ts");
  const contextMenu = read("src/ui/ContextMenu.tsx");
  const settings = read("src/ui/overlays/Settings.tsx");
  const docs = read("docs/设计-右键菜单与批量启动Agent.md");
  const shared = read("src/ui/shared.tsx");

  assert.match(html, /: "#c2683c"/);
  assert.doesNotMatch(html, /#e09070/);

  assert.match(sessionCard, /e\.key === "Escape"[\s\S]*stopRenaming\(\)/);
  assert.match(editor, /use crate::modules::util::expand_tilde;/);
  assert.match(editor, /let expanded_path = expand_tilde\(&path\);/);

  assert.match(terminal, /const writePty = \(data: string\) => \{/);
  assert.match(terminal, /pty\.write\(data\)\.catch/);
  assert.match(terminal, /pty\.write\(cmd \+ "\\n"\)[\s\S]*\.then\(\(\) => onPendingInputConsumedRef/);
  assert.match(terminal, /clearTimeout\(pendingInputTimer\)/);

  assert.doesNotMatch(status, /position: "absolute"/);
  assert.match(status, /margin: "4px 8px 0"/);

  assert.doesNotMatch(sessions, /launchAllAgents/);
  assert.doesNotMatch(sidebar, /启动所有 Agent/);
  assert.doesNotMatch(explorer, /启动所有 Agent/);
  assert.match(docs, /不做批量启动 Agent/);

  assert.match(contextMenu, /role="menu"/);
  assert.match(contextMenu, /ArrowDown/);
  assert.match(contextMenu, /role="separator"/);
  assert.match(contextMenu, /boxShadow: "var\(--shadow-menu\)"/);
  assert.match(contextMenu, /export type MenuIconName = "terminal" \| "editor" \| "copy" \| "rename" \| "close"/);
  assert.match(contextMenu, /id\?: string/);
  assert.match(contextMenu, /function menuEntryKey/);
  assert.match(contextMenu, /function MenuIcon/);
  assert.match(contextMenu, /aria-hidden="true"/);
  assert.match(shared, /export function SearchIcon/);
  assert.match(shared, /export function CloseIcon/);

  assert.match(settings, /CLI 路径检测失败/);
  assert.match(settings, /const loadCliStatus = useCallback/);
  assert.match(settings, /onClick=\{loadCliStatus\}/);
  assert.match(settings, /<RefreshIcon size=\{12\} \/>/);
  assert.match(settings, /CLI 路径/);
  assert.match(settings, /已找到 \$\{installedCliCount\}\/\$\{CLI_LIST\.length\}/);
  assert.match(settings, /未在当前应用 PATH 中找到/);
  assert.match(settings, /activeTab === "外观"/);
});

test("follow-up review fixes keep agent registry and batch close behavior centralized", () => {
  const registry = read("src/modules/agent/registry.ts");
  const lifecycle = read("src/modules/terminal/lib/agent-lifecycle.ts");
  const settings = read("src/ui/overlays/Settings.tsx");
  const types = read("src/ui/types.ts");
  const ui = read("src/state/ui.ts");
  const keys = read("src/app/useKeybindings.ts");
  const sessions = read("src/state/sessions.ts");
  const sessionCard = read("src/ui/SessionCard.tsx");
  const sidebar = read("src/ui/Sidebar.tsx");
  const palette = read("src/ui/overlays/CommandPalette.tsx");
  const resolver = read("src-tauri/src/modules/resolver/mod.rs");
  const toast = read("src/ui/Toast.tsx");

  assert.match(registry, /import agentRegistryData from "\.\/registry-data\.json" with \{ type: "json" \}/);
  assert.match(registry, /export const AGENT_REGISTRY/);
  assert.match(registry, /export const AGENT_COMMANDS/);
  assert.match(registry, /export const AGENT_NAMES/);
  assert.match(registry, /cliBin: string/);
  assert.match(read("src/modules/agent/registry-data.json"), /"cliBin": "gh"/);
  assert.match(lifecycle, /from "\.\.\/\.\.\/agent\/registry\.ts"/);
  assert.doesNotMatch(lifecycle, /const AGENT_COMMANDS: Record/);
  assert.match(settings, /const CLI_LIST = AGENT_REGISTRY\.map/);
  assert.match(resolver, /include_str!\("\.\.\/\.\.\/\.\.\/\.\.\/src\/modules\/agent\/registry-data\.json"\)/);
  assert.match(resolver, /fn resolver_uses_shared_agent_registry_data/);
  assert.match(types, /export const TERMINAL_THEME_NAMES = \[/);
  assert.match(types, /totalAdded: number; totalRemoved: number/);
  assert.match(types, /for \(const file of s\.changes\.files\)/);
  assert.match(ui, /TERMINAL_THEME_NAMES as readonly string\[\]/);
  assert.doesNotMatch(ui, /externalEditor: ExternalEditor;\n\n  setSidebarVisible/);
  assert.match(keys, /setFontSize\(DEFAULT_SETTINGS\.fontSize\)/);

  assert.match(sessions, /closeSessions: \(ids: string\[\]\) => boolean/);
  assert.match(sessions, /const closeConfirmationTimers = new Map/);
  assert.match(sessions, /function scheduleCloseConfirmationExpiry/);
  assert.match(sessions, /function scheduleDirCloseConfirmationExpiry/);
  assert.match(sessions, /const orderedTargets = get\(\)\.sessions\.filter/);
  assert.match(sessions, /unconfirmedBusy\.length > 0/);
  assert.match(sessions, /get\(\)\.closeSessions\(sessionIds\)/);
  assert.doesNotMatch(sessionCard, /onClearCloseConfirm/);
  assert.doesNotMatch(sessionCard, /session\.changes\?\.files\.reduce/);
  assert.doesNotMatch(sidebar, /onClearCloseConfirm/);
  assert.doesNotMatch(sidebar, /clearDirCloseConfirmation/);
  assert.match(sidebar, /label: "重命名", icon: "rename"/);
  assert.match(sidebar, /label: "关闭会话", icon: "close"/);
  assert.match(sidebar, /label: "关闭全部会话", icon: "close"/);
  assert.match(palette, /st\.closeSessions\(st\.sessions\.map/);
  assert.match(palette, /notifyBatchCloseConfirmation/);
  assert.match(toast, /exitingRef/);
});

test("follow-up review fixes polish dense UI surfaces", () => {
  const titlebar = read("src/ui/Titlebar.tsx");
  const sidebar = read("src/ui/Sidebar.tsx");
  const sidebarHeader = read("src/ui/SidebarDirGroupHeader.tsx");
  const sessionCard = read("src/ui/SessionCard.tsx");
  const main = read("src/ui/MainArea.tsx");
  const status = read("src/ui/AgentStatusBar.tsx");
  const settings = read("src/ui/overlays/Settings.tsx");
  const diff = read("src/ui/DiffPanel.tsx");
  const explorer = read("src/ui/FileExplorer.tsx");
  const filePreview = read("src/ui/FilePreview.tsx");
  const inspector = read("src/ui/InspectorPanel.tsx");
  const terminalSearch = read("src/ui/TerminalSearchBar.tsx");
  const toast = read("src/ui/Toast.tsx");
  const palette = read("src/ui/overlays/CommandPalette.tsx");
  const contextMenu = read("src/ui/ContextMenu.tsx");
  const globals = read("src/styles/globals.css");
  const tokens = read("src/styles/tokens.css");
  const iconUsers = [
    titlebar,
    sidebarHeader,
    sessionCard,
    diff,
    explorer,
    filePreview,
    inspector,
    terminalSearch,
    toast,
    settings,
    palette,
  ].join("\n");

  assert.match(titlebar, /width: 20, height: 20/);
  assert.match(titlebar, /paddingLeft: 8/);
  assert.match(sidebar, /padding: "8px 12px 6px"/);
  assert.match(sidebar, /className="no-scrollbar scroll-fade-y scroll-fade-sidebar"/);
  assert.doesNotMatch(sidebar, /底部：会话数/);
  assert.doesNotMatch(sidebar, />\s*会话\s*<\/span>/);
  assert.match(sidebarHeader, /padding: "6px 9px"/);
  assert.match(sidebarHeader, /import \{ CloseIcon, SearchIcon \} from "\.\/shared"/);
  assert.match(sidebarHeader, /export function SidebarSearchIcon\(\) \{\n  return <SearchIcon \/>;\n\}/);
  assert.doesNotMatch(iconUsers, /<line x1="18" y1="6" x2="6" y2="18"/);
  assert.doesNotMatch(iconUsers, /<path d="m21 21-4\.35-4\.35"/);
  assert.match(iconUsers, /<CloseIcon/);
  assert.match(terminalSearch, /<SearchIcon \/>/);
  assert.match(palette, /<SearchIcon size=\{14\} \/>/);
  assert.match(sessionCard, /transition: "opacity var\(--duration-fast\) ease"/);
  assert.match(sessionCard, /paddingLeft: 6/);
  assert.match(main, /"inset 0 2px 0 var\(--c-accent\)"/);
  assert.doesNotMatch(main, /outline: .*var\(--c-accent\)/);
  assert.match(main, /function SplitIcon/);
  assert.match(main, /title="左右分栏 ⌘D"/);
  assert.match(main, /title="上下分栏 ⌘⇧D"/);
  assert.match(main, /aria-label="左右分栏"/);
  assert.match(status, /\}, 1500\)/);
  assert.match(status, /transition: "opacity 0\.3s ease"/);
  assert.match(settings, /gridTemplateColumns: "repeat\(auto-fit, minmax\(118px, 1fr\)\)"/);
  assert.match(settings, /const previewBg =/);
  assert.match(settings, /const sidebarBg =/);
  assert.match(settings, /height: 56, background: previewBg/);
  assert.doesNotMatch(settings, /#ff5f57|#febc2e|#28c840/);
  assert.doesNotMatch(settings, /\[9, 6, 8\]/);
  assert.doesNotMatch(settings, /key=\{i\}/);
  assert.doesNotMatch(settings, /boxShadow: selected \?/);
  assert.match(settings, /className="no-scrollbar scroll-fade-y"/);
  assert.match(diff, /function remoteLabel\(remote: RemoteState \| null\): string/);
  assert.match(diff, /function buildMiniDiffRows\(patch: string\)/);
  assert.doesNotMatch(diff, /lines\.map\(\(line, i\)/);
  assert.match(diff, /Git 状态未知/);
  assert.match(diff, /className="no-scrollbar scroll-fade-y"/);
  assert.match(explorer, /function compactRelativePath/);
  assert.match(explorer, /className="no-scrollbar scroll-fade-y"/);
  assert.match(explorer, /label: "在此目录新建终端", icon: "terminal"/);
  assert.match(explorer, /label: "复制路径", icon: "copy"/);
  assert.doesNotMatch(explorer, /function SearchIcon/);
  assert.match(explorer, /minWidth: 48, textAlign: "right"/);
  assert.doesNotMatch(palette, /width: 3,[\s\S]*height: "60%"/);
  assert.match(palette, /className="no-scrollbar scroll-fade-y"/);
  assert.match(tokens, /--font-ui: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif;/);
  assert.equal(existsSync(resolve(root, "src/styles/tokens.ts")), false);
  assert.match(globals, /\.scroll-fade-y/);
  assert.match(globals, /background-repeat: no-repeat/);
  assert.match(globals, /\.scroll-fade-sidebar/);
  assert.match(globals, /@keyframes ctxMenuIn/);
  assert.match(contextMenu, /ctxMenuIn var\(--duration-fast\) ease/);
  assert.doesNotMatch(contextMenu, /key=\{`\$\{item\.label\}-\$\{i\}`\}/);
  assert.doesNotMatch(contextMenu, /key=\{`sep-\$\{i\}`\}/);
  assert.match(filePreview, /class UniqueKeyBuilder/);
  assert.doesNotMatch(filePreview, /key=\{i\}/);
});

test("review follow-up keeps terminal and sidebar hotspots split into focused pieces", () => {
  const terminal = read("src/ui/TerminalView.tsx");
  const terminalSearch = read("src/ui/TerminalSearchBar.tsx");
  const terminalSearchHook = read("src/ui/useTerminalSearch.ts");
  const terminalRuntimeSync = read("src/ui/useTerminalRuntimeSync.ts");
  const terminalBufferRead = read("src/modules/terminal/lib/terminal-buffer-read.ts");
  const terminalCommand = read("src/modules/terminal/lib/terminal-command.ts");
  const terminalInstance = read("src/modules/terminal/lib/terminal-instance.ts");
  const terminalOutput = read("src/modules/terminal/lib/terminal-output-buffer.ts");
  const terminalResize = read("src/modules/terminal/lib/terminal-resize.ts");
  const terminalInput = read("src/modules/terminal/lib/terminal-input-buffer.ts");
  const sidebar = read("src/ui/Sidebar.tsx");
  const sidebarHeader = read("src/ui/SidebarDirGroupHeader.tsx");

  assert.match(terminal, /import \{ TerminalSearchBar \} from "\.\/TerminalSearchBar"/);
  assert.match(terminal, /import \{ useTerminalSearch \} from "\.\/useTerminalSearch"/);
  assert.match(terminal, /import \{ useTerminalRuntimeSync \} from "\.\/useTerminalRuntimeSync"/);
  assert.match(terminal, /import \{ extractCommandFromBuffer, extractCommandFromOsc, getTerminalTailText \} from "@\/modules\/terminal\/lib\/terminal-buffer-read"/);
  assert.match(terminal, /import \{ isMeaningfulCommand \} from "@\/modules\/terminal\/lib\/terminal-command"/);
  assert.match(terminal, /import \{ createTerminalInstance \} from "@\/modules\/terminal\/lib\/terminal-instance"/);
  assert.match(terminal, /import \{ createTerminalOutputBuffer \} from "@\/modules\/terminal\/lib\/terminal-output-buffer"/);
  assert.match(terminal, /import \{ observeTerminalResize \} from "@\/modules\/terminal\/lib\/terminal-resize"/);
  assert.match(terminal, /import \{ scanTerminalInputBuffer \} from "@\/modules\/terminal\/lib\/terminal-input-buffer"/);
  assert.match(terminal, /createTerminalInstance\(\{/);
  assert.match(terminal, /createTerminalOutputBuffer\(term\)/);
  assert.match(terminal, /useTerminalRuntimeSync\(\{/);
  assert.match(terminal, /const search = useTerminalSearch\(termRef\)/);
  assert.match(terminal, /observeTerminalResize\(\{/);
  assert.match(terminal, /scanTerminalInputBuffer\(inputBuffer, data\)/);
  assert.match(terminalSearch, /export function TerminalSearchBar/);
  assert.match(terminalSearchHook, /export function useTerminalSearch/);
  assert.match(terminalSearchHook, /registerSearchAddon/);
  assert.match(terminalSearchHook, /handleCustomKeyEvent/);
  assert.match(terminalRuntimeSync, /export function useTerminalRuntimeSync/);
  assert.match(terminalRuntimeSync, /getTerminalTheme\(theme, terminalTheme, accent\)/);
  assert.match(terminalBufferRead, /export function extractCommandFromBuffer/);
  assert.match(terminalBufferRead, /export function extractCommandFromOsc/);
  assert.match(terminalBufferRead, /export function getTerminalTailText/);
  assert.match(terminalCommand, /export function isMeaningfulCommand/);
  assert.match(terminalInstance, /export function createTerminalInstance/);
  assert.match(terminalOutput, /export function createTerminalOutputBuffer/);
  assert.match(terminalResize, /export function observeTerminalResize/);
  assert.match(terminalResize, /new ResizeObserver/);
  assert.match(terminalInput, /export function scanTerminalInputBuffer/);
  assert.match(sidebar, /import \{ DirGroupHeader, SidebarSearchIcon \} from "\.\/SidebarDirGroupHeader"/);
  assert.match(sidebarHeader, /export function DirGroupHeader/);
  assert.doesNotMatch(terminal, /new ResizeObserver/);
  assert.doesNotMatch(terminal, /for \(let i = 0; i < data\.length; i \+= 1\)/);
  assert.doesNotMatch(terminal, /const NOISE_COMMANDS = new Set/);
  assert.doesNotMatch(terminal, /function getTerminalTailText/);

  assert.ok(terminal.split("\n").length < 500);
  assert.ok(sidebar.split("\n").length < 380);
});
