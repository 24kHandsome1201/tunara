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
  const changelog = read("CHANGELOG.md");

  const version = pkg.version;
  assert.equal(tauri.version, version);
  assert.match(cargo, new RegExp(`^version = "${version}"$`, "m"));
  assert.match(lock, new RegExp(`name = "conduit"\\nversion = "${version}"`));
  assert.match(cask, new RegExp(`version "${version}"`));
  assert.match(changelog, new RegExp(`## \\[${version}\\]`));

  assert.equal(tauri.identifier, "dev.conduit.app");
  assert.match(cask, /github\.com\/24kHandsome1201\/conduit/);
  assert.doesNotMatch(cask, /github\.com\/mawei\/conduit/);
  assert.doesNotMatch(cask, /PLACEHOLDER_SHA256/);
  assert.doesNotMatch(cask, /com\.conduit\.app/);
  assert.match(cask, /Application Support\/dev\.conduit\.app/);
  assert.match(tauri.plugins.updater.endpoints[0], /github\.com\/24kHandsome1201\/conduit/);
});

test("release cleanup removes orphan Rust modules from the source tree", () => {
  assert.equal(existsSync(resolve(root, "src-tauri/src/modules/secrets.rs")), false);
  assert.equal(existsSync(resolve(root, "src-tauri/src/modules/shell/mod.rs")), false);

  const modules = read("src-tauri/src/modules/mod.rs");
  const readme = read("README.md");
  const defaultCapability = JSON.parse(read("src-tauri/capabilities/default.json"));
  const generatedCapabilities = JSON.parse(read("src-tauri/gen/schemas/capabilities.json"));
  const desktopCapability = JSON.parse(read("src-tauri/capabilities/desktop.json"));

  assert.doesNotMatch(modules, /\bsecrets\b/);
  assert.doesNotMatch(modules, /\bshell\b/);
  assert.doesNotMatch(readme, /├── shell\//);
  assert.deepEqual(defaultCapability.windows, ["main"]);
  assert.ok(defaultCapability.permissions.includes("core:window:allow-request-user-attention"));
  assert.ok(generatedCapabilities.default.permissions.includes("core:window:allow-request-user-attention"));
  assert.deepEqual(desktopCapability.windows, ["main"]);
});

test("text config drives appearance, keybindings, and terminal font settings", () => {
  const agents = read("AGENTS.md");
  const cargo = read("src-tauri/Cargo.toml");
  const modules = read("src-tauri/src/modules/mod.rs");
  const lib = read("src-tauri/src/lib.rs");
  const configRs = read("src-tauri/src/modules/config.rs");
  const bridge = read("src/modules/config/config-bridge.ts");
  const keybindings = read("src/modules/config/keybindings.ts");
  const ui = read("src/state/ui.ts");
  const keys = read("src/app/useKeybindings.ts");
  const terminalInstance = read("src/modules/terminal/lib/terminal-instance.ts");
  const runtimeSync = read("src/ui/useTerminalRuntimeSync.ts");
  const terminalLigatures = read("src/modules/terminal/lib/terminal-ligatures.ts");
  const terminalLigatureSync = read("src/modules/terminal/lib/terminal-ligature-sync.ts");
  const terminalFont = read("src/modules/terminal/lib/terminal-font.ts");
  const settings = read("src/ui/overlays/Settings.tsx");

  assert.match(cargo, /^toml = "0\.8"$/m);
  assert.match(modules, /pub mod config;/);
  assert.match(lib, /modules::config::load_config/);
  assert.match(lib, /modules::config::save_config/);
  assert.match(configRs, /\.join\("\.config"\)[\s\S]*\.join\("conduit"\)[\s\S]*\.join\("config\.toml"\)/);
  assert.match(configRs, /fs::rename\(&tmp, path\)/);
  assert.match(configRs, /pub font_ligatures: bool/);
  assert.match(configRs, /font_ligatures: false/);
  assert.match(configRs, /pub terminal_clipboard_write: bool/);
  assert.match(configRs, /terminal_clipboard_write: false/);
  assert.match(agents, /OSC 52 剪贴板是安全 sink/);
  assert.match(agents, /terminal_clipboard_write = true/);
  assert.match(agents, /不要实现剪贴板读取响应/);
  assert.match(configRs, /\("quick_select", "Mod\+Shift\+Space"\)/);
  const defaultConfigKeys = [...configRs.matchAll(/\("([a-z0-9_]+)", "Mod\+[^"]+"\)/g)].map((m) => m[1]);
  assert.equal(new Set(defaultConfigKeys).size, defaultConfigKeys.length);
  assert.match(bridge, /invoke<LoadedConduitConfig>\("load_config"\)/);
  assert.match(bridge, /invoke\("save_config", \{ config \}\)/);
  assert.match(bridge, /font_ligatures: boolean/);
  assert.match(bridge, /terminal_clipboard_write: boolean/);
  assert.match(keybindings, /export const DEFAULT_KEYBINDINGS/);
  assert.match(keybindings, /newTerminalAlt: "Mod\+N"/);
  assert.match(keybindings, /quickSelect: "Mod\+Shift\+Space"/);
  assert.match(keybindings, /export function hasPlatformModKey/);
  assert.match(keybindings, /export function matchesKeybinding/);
  assert.match(keybindings, /const modPressed = hasPlatformModKey\(e, isMac\)/);
  assert.match(ui, /loadConduitConfig/);
  assert.match(ui, /saveConduitConfig\(settingsToRawConfig/);
  assert.match(ui, /fontLigatures: false/);
  assert.match(ui, /font_ligatures: s\.fontLigatures/);
  assert.match(ui, /terminalClipboardWrite: false/);
  assert.match(ui, /terminal_clipboard_write: s\.terminalClipboardWrite/);
  assert.doesNotMatch(ui, /localStorage/);
  assert.doesNotMatch(ui, /sessionStorage/);
  assert.match(keys, /hasPlatformModKey\(e, isMac\)/);
  assert.doesNotMatch(keys, /isEditableTarget\(e\.target\) && !e\.metaKey/);
  assert.match(keys, /matchesKeybinding\(e, bindings\[action\], isMac\)/);
  assert.match(keys, /TERMINAL_QUICK_SELECT_EVENT/);
  assert.match(terminalFont, /buildTerminalFontFamily/);
  assert.match(terminalInstance, /wordSeparator: " \(\)\[\]\{\}'\\";,"/);
  assert.match(runtimeSync, /from "@\/modules\/terminal\/lib\/terminal-font"/);
  assert.match(runtimeSync, /term\.options\.fontFamily = buildTerminalFontFamily/);
  assert.match(terminalLigatures, /registerCharacterJoiner/);
  assert.match(terminalLigatures, /deregisterCharacterJoiner/);
  assert.match(terminalLigatureSync, /useUIStore\.subscribe\(\(s\) => s\.fontLigatures/);
  assert.match(terminalLigatureSync, /registerTerminalLigatures\(term\)/);
  assert.match(settings, /setFontFamily\(fontDraft\)/);
  assert.match(settings, /setFontLigatures\(!fontLigatures\)/);
  assert.match(settings, /setTerminalClipboardWrite\(!terminalClipboardWrite\)/);
  assert.match(settings, /Nerd Font/);
  assert.match(settings, /连字/);
  assert.match(settings, /configPath/);
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
  assert.match(init, /const scheduleSave = \(\) => \{/);
  assert.match(init, /setTimeout\(\(\) => \{[\s\S]*?persistNow\(\);[\s\S]*?\}, 500\)/);
  assert.match(init, /scheduleSave\(\);/);
  assert.match(init, /const timer = setInterval\(persistNow, 30_000\);/);
  assert.match(init, /onCloseRequested\(async \(\) => \{[\s\S]*?clearTimeout\(saveTimer\);[\s\S]*?await saveWorkspaceSnapshot/);
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
  assert.match(init, /sidebarVisible: snapshot\.ui\.sidebarVisible/);
  assert.match(init, /panelVisible: snapshot\.ui\.panelVisible/);
  assert.match(init, /const agentResume: WorkspaceSnapshotV1\["agentResume"\] = \{\}/);
  assert.match(init, /if \(s\.agentResume\) agentResume\[s\.id\] = s\.agentResume/);
  assert.match(init, /agentResume,/);
  assert.match(init, /recentDirs: st\.recentDirs/);
  assert.match(init, /recentCommands: st\.recentCommands/);
  assert.match(init, /recentDirs: snapshot\.recentDirs/);
  assert.match(init, /recentCommands: snapshot\.recentCommands/);
  assert.match(init, /agentResume: snapshot\.agentResume\[p\.id\]/);
});

test("terminal panes keep stable keyed mounts across single/split so the agent PTY survives", () => {
  const main = read("src/ui/MainArea.tsx");
  const handle = read("src/ui/SplitHandle.tsx");

  // Single stable-keyed mount list (no dual single/split render branches that
  // would unmount the active session's TerminalView and kill its PTY).
  assert.match(main, /function paneWrapperStyle\(s: Session\): React\.CSSProperties/);
  assert.match(main, /mountedSessions\.map\(\(s\) => \([\s\S]*?key=\{s\.id\}[\s\S]*?renderTerminalPane\(s, s\.id === activeSessionId\)/);
  assert.match(main, /order: isPaneA \? 0 : 2/);
  // Regression shape from the removed single-mode branch must be gone.
  assert.doesNotMatch(main, /display: isActive \? "flex" : "none"/);
  // SplitHandle takes the middle flex slot via an order prop.
  assert.match(handle, /order\?: number/);
  assert.match(main, /containerRef=\{splitContainerRef\}\s*order=\{1\}/);
});

test("file previews and markdown rendering stay bounded", () => {
  const rust = read("src-tauri/src/modules/fs/file.rs");
  const bridge = read("src/modules/fs/fs-bridge.ts");
  const preview = read("src/ui/FilePreview.tsx");
  const git = read("src-tauri/src/modules/git/mod.rs");
  const gitBridge = read("src/modules/git/git-bridge.ts");

  assert.match(rust, /const MAX_TEXT_PREVIEW_BYTES: u64 = 256 \* 1024/);
  assert.match(rust, /truncated: bool/);
  assert.match(rust, /take\(MAX_TEXT_PREVIEW_BYTES \+ 1\)/);
  assert.match(rust, /bytes\.truncate\(MAX_TEXT_PREVIEW_BYTES as usize\)/);
  assert.match(bridge, /truncated\?: boolean/);
  assert.match(preview, /useMemo/);
  assert.match(preview, /result\.truncated \? "\\n… 已截断" : ""/);
  assert.match(git, /out\.len\(\) \+ content\.len\(\) \+ prefix_len > DIFF_MAX_BYTES/);
  assert.match(git, /commit` 模块只在 `cfg\(test\)` 下保留旧写路径的 pathspec 回归 fixture/);
  assert.match(gitBridge, /git\/mod\.rs 的只读 IPC 契约/);
  assert.doesNotMatch(gitBridge, /git\/mod\.rs \+ git\/commit\.rs 的命令契约/);
});

test("appearance settings are sanitized and command palette exposes useful actions", () => {
  const ui = read("src/state/ui.ts");
  const palette = read("src/ui/overlays/CommandPalette.tsx");
  const paletteFilter = read("src/ui/overlays/command-palette-filter.ts");
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
  assert.match(palette, /parseCommandPaletteQuery\(query\)/);
  assert.match(palette, /rankCommandPaletteItems\(filtered, parsedQuery, usage\)/);
  assert.match(paletteFilter, /actions: "action"/);
  assert.match(paletteFilter, /sessions: "session"/);
  assert.match(paletteFilter, /terminal: "terminal"/);
  assert.match(paletteFilter, /labelMatchIndex/);
  assert.match(palette, /ranked\.length === 0 \? 0 : Math\.min\(index, ranked\.length - 1\)/);
  assert.match(palette, /for \(const \[globalIdx, cmd\] of ranked\.entries\(\)\)/);
  assert.doesNotMatch(palette, /ranked\.indexOf/);
  assert.match(sidebar, /const canReorder = q\.length === 0/);
  assert.match(sidebar, /if \(!canReorder\) return;/);
  assert.match(toast, /exitTimerRef/);
  assert.match(toast, /minWidth: 260/);
  assert.match(toast, /maxWidth: "min\(340px, calc\(100vw - 24px\)\)"/);
  assert.match(toast, /borderLeft: `3px solid \$\{accentColor\}`/);
  assert.doesNotMatch(toast, /width: 260/);
  assert.match(css, /prefers-reduced-motion: reduce/);
});

test("review fixes remove stale artifacts and guard high-risk regressions", () => {
  const html = read("index.html");
  const sessionCard = read("src/ui/SessionCard.tsx");
  const editor = read("src-tauri/src/modules/editor/mod.rs");
  const editorBridge = read("src/modules/editor/open.ts");
  const terminal = read("src/ui/TerminalView.tsx");
  const terminalFileLinks = read("src/modules/terminal/lib/terminal-file-links.ts");
  const terminalLineCwd = read("src/modules/terminal/lib/terminal-line-cwd.ts");
  const terminalFileLinkParser = read("src/modules/terminal/lib/terminal-file-link-parser.ts");
  const pendingInput = read("src/modules/terminal/lib/terminal-pending-input.ts");
  const terminalProgress = read("src/modules/terminal/lib/terminal-progress.ts");
  const terminalOsc9 = read("src/modules/terminal/lib/terminal-osc9.ts");
  const terminalNotification = read("src/modules/terminal/lib/terminal-notification.ts");
  const status = read("src/ui/AgentStatusBar.tsx");
  const sidebar = read("src/ui/Sidebar.tsx");
  const explorer = read("src/ui/FileExplorer.tsx");
  const sessions = read("src/state/sessions.ts");
  const ui = read("src/state/ui.ts");
  const contextMenu = read("src/ui/ContextMenu.tsx");
  const settings = read("src/ui/overlays/Settings.tsx");
  const docs = read("docs/设计-右键菜单与批量启动Agent.md");
  const shared = read("src/ui/shared.tsx");

  assert.match(html, /: "#c2683c"/);
  assert.doesNotMatch(html, /#e09070/);

  assert.match(sessionCard, /e\.key === "Escape"[\s\S]*stopRenaming\(\)/);
  assert.match(editor, /use crate::modules::util::expand_tilde;/);
  assert.match(editor, /let expanded_path = expand_tilde\(&path\);/);
  assert.match(editor, /column: Option<u32>/);
  assert.match(editorBridge, /column\?: number/);

  assert.match(terminal, /const writePty = \(data: string\) => \{/);
  assert.match(terminal, /pty\.write\(data\)\.catch/);
  assert.match(terminal, /schedulePendingInput\(\{/);
  assert.match(terminal, /registerTerminalFileLinkProvider\(term/);
  assert.match(terminal, /createTerminalLineCwdTracker\(\)/);
  assert.match(terminal, /lineCwdTracker\.record\(cwd, term\.registerMarker\(0\)\)/);
  assert.match(terminalFileLinks, /term\.registerLinkProvider/);
  assert.match(terminalFileLinks, /options\.getCwd\(bufferLineNumber\)/);
  assert.match(terminalLineCwd, /last\?\.cwd === normalized/);
  assert.match(terminalFileLinks, /openInEditor\(options\.getEditor\(\), path, match\.line, match\.column\)/);
  assert.match(terminalFileLinkParser, /findTerminalFileLinkMatches/);
  assert.match(terminalFileLinkParser, /resolveTerminalFileLinkPath/);
  assert.match(pendingInput, /pty\.write\(submit \? input \+ "\\n" : input\)/);
  assert.match(pendingInput, /clearTimeout\(timer\)/);
  assert.match(terminal, /registerTerminalOsc9Handler\(term/);
  assert.match(terminal, /emitTerminalNotification\(sessionIdRef\.current, notification\)/);
  assert.match(terminalProgress, /parseTerminalProgressOsc/);
  assert.match(terminalProgress, /parts\[0\] !== "4"/);
  assert.match(terminalOsc9, /parseTerminalProgressOsc\(data\)/);
  assert.match(terminalOsc9, /parseConEmuCwdOsc9\(data\)/);
  assert.match(terminalOsc9, /parseTerminalNotificationOsc9\(data\)/);
  assert.match(terminalOsc9, /registerOscHandler\(9/);
  assert.match(terminalNotification, /parseTerminalNotificationOsc9/);
  assert.match(terminalNotification, /parseTerminalNotificationOsc777/);
  assert.match(terminalNotification, /\^\\s\*\\d\+\(\?:;\|\$\)/);

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
  assert.match(contextMenu, /export type MenuIconName = "terminal" \| "editor" \| "copy" \| "rename" \| "search" \| "close"/);
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
  assert.match(settings, /onClick=\{\(\) => useUIStore\.getState\(\)\.resetAppearance\(\)\}/);
  assert.match(ui, /resetAppearance: \(\) => set\(\(s\) => \(\{ \.\.\.DEFAULT_SETTINGS, keybindings: s\.keybindings \}\)\)/);
  assert.doesNotMatch(ui, /resetAppearance: \(\) => set\(\{ \.\.\.DEFAULT_SETTINGS, keybindings: \{ \.\.\.DEFAULT_KEYBINDINGS \} \}\)/);
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
  const registryData = read("src/modules/agent/registry-data.json");
  assert.match(registryData, /"cliBin": "gh"/);
  assert.match(registryData, /"commands": \["cursor-agent"\]/);
  assert.match(registryData, /"cliBin": "cursor-agent"/);
  assert.doesNotMatch(registryData, /"commands": \["agent"\]/);
  assert.match(lifecycle, /from "\.\.\/\.\.\/agent\/registry\.ts"/);
  assert.doesNotMatch(lifecycle, /const AGENT_COMMANDS: Record/);
  assert.match(settings, /const CLI_LIST = AGENT_REGISTRY\.map/);
  assert.match(resolver, /include_str!\("\.\.\/\.\.\/\.\.\/\.\.\/src\/modules\/agent\/registry-data\.json"\)/);
  assert.match(resolver, /fn resolver_uses_shared_agent_registry_data/);
  const preflight = read("src-tauri/src/modules/agent/preflight.rs");
  assert.match(preflight, /include_str!\("\.\.\/\.\.\/\.\.\/\.\.\/src\/modules\/agent\/registry-data\.json"\)/);
  assert.match(preflight, /fn preflight_uses_shared_agent_registry_data/);
  assert.doesNotMatch(preflight, /"cline" => Some/);
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
  assert.match(palette, /collectRecentTerminalDirs\(recentDirs, activeSession\.dir\)/);
  assert.match(palette, /newTerminalInDir\(entry\.dir\)/);
  assert.match(palette, /collectRecentTerminalCommands\(recentCommands, activeSession\.lastCommand\)/);
  assert.match(palette, /newTerminalWithInput\(entry\.command, activeSession\.dir\)/);
  assert.match(sessions, /recordRecentCommand: \(command\)/);
  assert.match(sessions, /pendingInputSubmit: false/);
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

  assert.match(titlebar, /width: 16, height: 16/);
  assert.match(titlebar, /paddingLeft: 8/);
  assert.match(sidebar, /padding: "8px 12px 6px"/);
  assert.match(sidebar, /className="no-scrollbar scroll-fade-y scroll-fade-sidebar"/);
  assert.match(sidebar, /const visibleSessionIds = groupEntries\.flatMap/);
  assert.match(sidebar, /const tabbableSessionId = visibleSessionIds\.includes\(activeSessionId\)/);
  assert.match(sidebar, /const handleSessionKeyDown = useCallback/);
  assert.match(sidebar, /ArrowDown/);
  assert.match(sidebar, /ArrowUp/);
  assert.match(sidebar, /Home/);
  assert.match(sidebar, /End/);
  assert.match(sidebar, /role="list"/);
  assert.match(sidebar, /aria-label="会话列表"/);
  assert.doesNotMatch(sidebar, /底部：会话数/);
  assert.doesNotMatch(sidebar, />\s*会话\s*<\/span>/);
  assert.match(sidebarHeader, /padding: "5px 9px"/);
  assert.match(sidebarHeader, /import \{ CloseIcon, SearchIcon \} from "\.\/shared"/);
  assert.match(sidebarHeader, /export function SidebarSearchIcon\(\) \{\n  return <SearchIcon \/>;\n\}/);
  assert.doesNotMatch(iconUsers, /<line x1="18" y1="6" x2="6" y2="18"/);
  assert.doesNotMatch(iconUsers, /<path d="m21 21-4\.35-4\.35"/);
  assert.match(iconUsers, /<CloseIcon/);
  assert.match(terminalSearch, /<SearchIcon size=\{13\} color=\{hasResults \? "var\(--c-accent\)" : noMatch \? "var\(--c-error\)" : "var\(--c-text-5\)"\} \/>/);
  assert.match(palette, /<SearchIcon size=\{14\} \/>/);
  assert.match(sessionCard, /transition: "opacity var\(--duration-fast\) ease"/);
  assert.match(sessionCard, /paddingLeft: 6/);
  assert.match(sessionCard, /data-session-card-id=\{session\.id\}/);
  assert.match(sessionCard, /tabIndex=\{tabIndex \?\? 0\}/);
  assert.match(sessionCard, /aria-current=\{active \? "page" : undefined\}/);
  assert.match(sessionCard, /boxShadow: focused \?/);
  assert.match(sessionCard, /function TerminalProgressBar/);
  assert.match(sessionCard, /session\.terminalProgress && <TerminalProgressBar/);
  assert.match(main, /inset 0 2px 0 var\(--c-accent\)/);
  assert.doesNotMatch(main, /outline: .*var\(--c-accent\)/);
  assert.match(main, /function SplitIcon/);
  assert.match(main, /title="左右分栏 ⌘D"/);
  assert.match(main, /title="上下分栏 ⌘⇧D"/);
  assert.match(main, /aria-label="左右分栏"/);
  assert.match(status, /\}, 1500\)/);
  assert.match(status, /transition: "opacity 0\.3s ease, transform 0\.3s var\(--ease-out-expo\)"/);
  assert.match(settings, /gridTemplateColumns: "repeat\(auto-fit, minmax\(118px, 1fr\)\)"/);
  assert.match(settings, /const previewBg =/);
  assert.match(settings, /const sidebarBg =/);
  assert.match(settings, /height: 62, background: previewBg/);
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
  assert.match(tokens, /--font-ui: 'Inter Variable', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif;/);
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
  const terminalChrome = read("src/ui/TerminalViewChrome.tsx");
  const terminalSearch = read("src/ui/TerminalSearchBar.tsx");
  const terminalSearchHook = read("src/ui/useTerminalSearch.ts");
  const terminalBlockFilter = read("src/modules/terminal/lib/terminal-block-filter.ts");
  const terminalBlockFilterPanel = read("src/ui/TerminalBlockFilterPanel.tsx");
  const terminalRuntimeSync = read("src/ui/useTerminalRuntimeSync.ts");
  const terminalWebgl = read("src/ui/useTerminalWebgl.ts");
  const terminalQuickSelect = read("src/modules/terminal/lib/terminal-quick-select.ts");
  const terminalQuickSelectScope = read("src/modules/terminal/lib/terminal-quick-select-scope.ts");
  const terminalQuickSelectHook = read("src/ui/useTerminalQuickSelect.tsx");
  const terminalQuickSelectOverlay = read("src/ui/TerminalQuickSelect.tsx");
  const terminalAttention = read("src/ui/terminal-attention.ts");
  const terminalBlocks = read("src/ui/useTerminalBlocks.ts");
  const terminalBlocksBar = read("src/ui/TerminalBlocksBar.tsx");
  const terminalBufferRead = read("src/modules/terminal/lib/terminal-buffer-read.ts");
  const terminalCodexState = read("src/modules/terminal/lib/terminal-codex-state.ts");
  const terminalCommand = read("src/modules/terminal/lib/terminal-command.ts");
  const terminalFont = read("src/modules/terminal/lib/terminal-font.ts");
  const terminalHyperlinks = read("src/modules/terminal/lib/terminal-hyperlinks.ts");
  const terminalInstance = read("src/modules/terminal/lib/terminal-instance.ts");
  const terminalOutput = read("src/modules/terminal/lib/terminal-output-buffer.ts");
  const terminalPasteProtection = read("src/modules/terminal/lib/terminal-paste-protection.ts");
  const terminalPending = read("src/modules/terminal/lib/terminal-pending-input.ts");
  const terminalClipboard = read("src/modules/terminal/lib/terminal-clipboard.ts");
  const terminalDeviceAttributes = read("src/modules/terminal/lib/terminal-device-attributes.ts");
  const terminalSnapshotScheduler = read("src/modules/terminal/lib/terminal-snapshot-scheduler.ts");
  const terminalResize = read("src/modules/terminal/lib/terminal-resize.ts");
  const terminalInput = read("src/modules/terminal/lib/terminal-input-buffer.ts");
  const commandPalette = read("src/ui/overlays/CommandPalette.tsx");
  const keybindings = read("src/modules/config/keybindings.ts");
  const appKeybindings = read("src/app/useKeybindings.ts");
  const sidebar = read("src/ui/Sidebar.tsx");
  const sidebarHeader = read("src/ui/SidebarDirGroupHeader.tsx");

  assert.match(terminal, /import \{ TerminalViewChrome \} from "\.\/TerminalViewChrome"/);
  assert.match(terminal, /import \{ emitTerminalNotification, requestInformationalAttention \} from "\.\/terminal-attention"/);
  assert.match(terminal, /registerTerminalClipboardHandler\(term/);
  assert.match(terminal, /registerTerminalDeviceAttributesHandler\(term/);
  assert.match(terminal, /terminalClipboardWrite/);
  assert.match(terminalClipboard, /registerOscHandler\(52/);
  assert.match(terminalClipboard, /handleTerminalClipboardOsc52/);
  assert.match(terminalClipboard, /if \(!options\.isWriteAllowed\(\)\) return true/);
  assert.match(terminalClipboard, /payload\.data === "\?"/);
  assert.match(terminalClipboard, /MAX_OSC52_CLIPBOARD_BYTES = 256 \* 1024/);
  assert.doesNotMatch(terminalClipboard, /readText/);
  assert.match(terminalDeviceAttributes, /registerCsiHandler\(\{ final: "c" \}/);
  assert.match(terminalDeviceAttributes, /buildPrimaryDeviceAttributesResponse/);
  assert.match(terminalDeviceAttributes, /"1;2;52"/);
  assert.match(terminalDeviceAttributes, /isOsc52ClipboardWriteAllowed/);
  assert.match(terminalAttention, /import \{ getCurrentWindow, UserAttentionType \} from "@tauri-apps\/api\/window"/);
  assert.match(terminalAttention, /requestUserAttention\(UserAttentionType\.Informational\)[\s\S]*\.catch\(\(\) => \{\}\)/);
  assert.doesNotMatch(terminal, /requestUserAttention\(2\)/);
  assert.doesNotMatch(terminalAttention, /requestUserAttention\(2\)/);
  assert.match(terminal, /import \{ useTerminalSearch \} from "\.\/useTerminalSearch"/);
  assert.match(terminal, /import \{ useTerminalQuickSelect \} from "\.\/useTerminalQuickSelect"/);
  assert.match(terminal, /import \{ useTerminalRuntimeSync \} from "\.\/useTerminalRuntimeSync"/);
  assert.match(terminal, /import \{ extractCommandFromBuffer, extractCommandFromOsc \} from "@\/modules\/terminal\/lib\/terminal-buffer-read"/);
  assert.match(terminal, /import \{ createCodexScreenStateTracker \} from "@\/modules\/terminal\/lib\/terminal-codex-state"/);
  assert.match(terminal, /import \{ isMeaningfulCommand \} from "@\/modules\/terminal\/lib\/terminal-command"/);
  assert.match(terminal, /import \{ waitForTerminalFontReady \} from "@\/modules\/terminal\/lib\/terminal-font"/);
  assert.match(terminal, /import \{ createTerminalHyperlinkHandler \} from "@\/modules\/terminal\/lib\/terminal-hyperlinks"/);
  assert.match(terminal, /import \{ createTerminalInstance \} from "@\/modules\/terminal\/lib\/terminal-instance"/);
  assert.match(terminal, /import \{ createTerminalOutputBuffer \} from "@\/modules\/terminal\/lib\/terminal-output-buffer"/);
  assert.match(terminal, /import \{ registerTerminalPasteProtection \} from "@\/modules\/terminal\/lib\/terminal-paste-protection"/);
  assert.match(terminal, /import \{ schedulePendingInput \} from "@\/modules\/terminal\/lib\/terminal-pending-input"/);
  assert.match(terminal, /import \{ observeTerminalResize \} from "@\/modules\/terminal\/lib\/terminal-resize"/);
  assert.match(terminal, /import \{ scanTerminalInputBuffer \} from "@\/modules\/terminal\/lib\/terminal-input-buffer"/);
  assert.match(terminal, /import \{ useTerminalWebgl, type TerminalWebglRenderer \} from "\.\/useTerminalWebgl"/);
  assert.match(terminal, /createTerminalInstance\(\{/);
  assert.match(terminal, /linkHandler: createTerminalHyperlinkHandler\(openUrl\)/);
  assert.match(terminal, /cleanups\.push\(registerTerminalPasteProtection\(term\)\.dispose\)/);
  assert.match(terminal, /createTerminalOutputBuffer\(term\)/);
  assert.match(terminal, /useTerminalRuntimeSync\(\{/);
  assert.match(terminal, /useTerminalBlocks\(termRef\)/);
  assert.match(terminal, /useTerminalQuickSelect\(termRef, \{ active, cwd: dir, sessionId \}\)/);
  assert.match(terminal, /quickSelectOverlay=\{quickSelect\.quickSelectOverlay\}/);
  assert.match(terminal, /blocks\.registerScrollTracking\(term\)/);
  assert.match(terminal, /blocks\.updateActiveBlockEnd\(currentBufferRow\(\)\)/);
  assert.match(terminal, /term\.attachCustomKeyEventHandler\(\(e\) => search\.handleCustomKeyEvent\(e\) && blocks\.handleCustomKeyEvent\(e\)\)/);
  assert.match(terminal, /const search = useTerminalSearch\(termRef\)/);
  assert.match(terminal, /observeTerminalResize\(\{/);
  assert.match(terminal, /scanTerminalInputBuffer\(inputBuffer, data\)/);
  assert.match(terminalChrome, /import \{ TerminalSearchBar \} from "\.\/TerminalSearchBar"/);
  assert.match(terminalChrome, /import \{ TerminalBlockFilterPanel \} from "\.\/TerminalBlockFilterPanel"/);
  assert.match(terminalChrome, /import \{ TerminalBlocksBar \} from "\.\/TerminalBlocksBar"/);
  assert.match(terminalChrome, /quickSelectOverlay\?: ReactNode/);
  assert.match(terminalChrome, /onReadBlockOutput: \(id: string\) => string \| null/);
  assert.match(terminalChrome, /useState<\{ block: TerminalCommandBlock; output: string \} \| null>/);
  assert.match(terminalChrome, /onFilterBlock=\{\(block\) => \{/);
  assert.match(terminalChrome, /setBlockFilter\(\{ block, output \}\)/);
  assert.match(terminalChrome, /<TerminalBlockFilterPanel/);
  assert.match(terminalChrome, /\{quickSelectOverlay\}/);
  assert.match(terminalQuickSelect, /TERMINAL_QUICK_SELECT_EVENT/);
  assert.match(terminalQuickSelect, /export type TerminalQuickSelectKind = "url" \| "file" \| "text"/);
  assert.match(terminalQuickSelect, /export function collectTerminalQuickSelectItems/);
  assert.match(terminalQuickSelect, /export function findTerminalQuickSelectTextTokens/);
  assert.match(terminalQuickSelect, /GIT_HASH_RE/);
  assert.match(terminalQuickSelect, /IPV4_RE/);
  assert.match(terminalQuickSelect, /NUMBER_RE/);
  assert.match(terminalQuickSelect, /copyText: match\.text/);
  assert.match(terminalQuickSelect, /findTerminalFileLinkMatches/);
  assert.match(terminalQuickSelect, /resolveTerminalFileLinkPath/);
  assert.match(terminalQuickSelect, /export function quickSelectHint/);
  assert.match(terminalQuickSelectScope, /TERMINAL_QUICK_SELECT_SCOPE_LINES = 1000/);
  assert.match(terminalQuickSelectScope, /export function terminalQuickSelectRange/);
  assert.match(terminalQuickSelectHook, /readQuickSelectTerminalLines/);
  assert.match(terminalQuickSelectHook, /terminalQuickSelectRange\(buffer\.length, buffer\.viewportY, term\.rows\)/);
  assert.match(terminalQuickSelectHook, /collectTerminalQuickSelectItems\(readQuickSelectTerminalLines\(term\), cwd\)/);
  assert.match(terminalQuickSelectHook, /URL、文件位置或可复制标识/);
  assert.match(terminalQuickSelectHook, /window\.addEventListener\(TERMINAL_QUICK_SELECT_EVENT/);
  assert.match(terminalQuickSelectHook, /navigator\.clipboard\.writeText\(item\.copyText\)/);
  assert.match(terminalQuickSelectHook, /if \(item\.kind === "text"\) \{[\s\S]*copyItem\(item\);[\s\S]*return;/);
  assert.match(terminalQuickSelectHook, /openInEditor\(useUIStore\.getState\(\)\.externalEditor, item\.target, item\.line, item\.column\)/);
  assert.match(terminalQuickSelectOverlay, /export function TerminalQuickSelect/);
  assert.match(terminalQuickSelectOverlay, /item\.kind !== "text"/);
  assert.match(terminalQuickSelectOverlay, /quickSelectHint\(index\)/);
  assert.match(terminalQuickSelectOverlay, /onCopy\(hintedItems\[exact\]\.item\)/);
  assert.match(commandPalette, /id: "quick-select-visible-output"/);
  assert.match(commandPalette, /label: "快速选择附近输出"/);
  assert.match(commandPalette, /window\.dispatchEvent\(new CustomEvent\(TERMINAL_QUICK_SELECT_EVENT\)\)/);
  assert.match(keybindings, /"quickSelect"/);
  assert.match(appKeybindings, /case "quickSelect"/);
  assert.match(appKeybindings, /hasPlatformModKey\(e, isMac\)/);
  assert.doesNotMatch(appKeybindings, /isEditableTarget\(e\.target\) && !e\.metaKey/);
  assert.match(terminalSearch, /export function TerminalSearchBar/);
  assert.match(terminalSearchHook, /export function useTerminalSearch/);
  assert.match(terminalSearchHook, /registerSearchAddon/);
  assert.match(terminalSearchHook, /handleCustomKeyEvent/);
  assert.match(terminalBlockFilter, /export function filterTerminalBlockOutput/);
  assert.match(terminalBlockFilter, /export function formatTerminalBlockFilterText/);
  assert.match(terminalBlockFilter, /invalidRegex: true/);
  assert.match(terminalBlockFilterPanel, /filterTerminalBlockOutput/);
  assert.match(terminalBlockFilterPanel, /formatTerminalBlockFilterText/);
  assert.match(terminalBlockFilterPanel, /FILTER_RENDER_LIMIT = 500/);
  assert.match(terminalBlockFilterPanel, /setContextLines\(Number\(event\.target\.value\)\)/);
  assert.match(terminalRuntimeSync, /export function useTerminalRuntimeSync/);
  assert.match(terminalRuntimeSync, /getTerminalTheme\(theme, terminalTheme, accent\)/);
  assert.match(terminalWebgl, /export function useTerminalWebgl/);
  assert.match(terminalHyperlinks, /export function normalizeTerminalHyperlink/);
  assert.match(terminalHyperlinks, /allowNonHttpProtocols: false/);
  assert.match(terminalHyperlinks, /url\.protocol !== "http:" && url\.protocol !== "https:"/);
  assert.match(terminalInstance, /linkHandler\?: ILinkHandler \| null/);
  assert.match(terminalInstance, /linkHandler,/);
  assert.match(terminalPasteProtection, /TERMINAL_LARGE_PASTE_WARNING_LENGTH = 5 \* 1024/);
  assert.match(terminalPasteProtection, /export function analyzeTerminalPaste/);
  assert.match(terminalPasteProtection, /event\.preventDefault\(\)/);
  assert.match(terminalPasteProtection, /term\.paste\(value\)/);
  assert.match(terminalBlocks, /export function useTerminalBlocks/);
  assert.match(terminalBlocks, /export function findStickyCommandBlock/);
  assert.match(terminalBlocks, /export function findNavigableCommandBlock/);
  assert.match(terminalBlocks, /export function normalizeBlockCommand/);
  assert.match(terminalBlocks, /export function collectTerminalBlockOutputText/);
  assert.match(terminalBlocks, /export function formatTerminalBlockCommandAndOutput/);
  assert.match(terminalBlocks, /import \{ hasPlatformModKey \} from "\.\.\/modules\/config\/keybindings\.ts"/);
  assert.match(terminalBlocks, /function detectMacPlatform\(\): boolean/);
  assert.match(terminalBlocks, /function hasBlockNavigationModifier\(e: KeyboardEvent\): boolean/);
  assert.match(terminalBlocks, /hasPlatformModKey\(e, isMac\) && \(isMac \? !e\.ctrlKey : !e\.metaKey\)/);
  assert.doesNotMatch(terminalBlocks, /@tauri-apps\/plugin-os/);
  assert.doesNotMatch(terminalBlocks, /slice\(0, 77\) \+ "\.\.\."/);
  assert.match(terminalBlocks, /block\.startRow \+ 1/);
  assert.match(terminalBlocks, /readBlockOutputText/);
  assert.match(terminalBlocks, /const copyBlockOutput = useCallback\(async \(id: string\): Promise<boolean> =>/);
  assert.match(terminalBlocks, /const output = readBlockOutput\(id\)/);
  assert.match(terminalBlocks, /if \(output === null\) return false/);
  assert.match(terminalBlocks, /writeText\(output\)/);
  assert.match(terminalBlocks, /const copyBlockCommand = useCallback\(async \(id: string\): Promise<boolean> =>/);
  assert.match(terminalBlocks, /const copyBlockCommandAndOutput = useCallback\(async \(id: string\): Promise<boolean> =>/);
  assert.match(terminalBlocks, /const readBlockOutput = useCallback\(\(id: string\): string \| null =>/);
  assert.match(terminalBlocks, /return readBlockOutputText\(term, block\)/);
  assert.match(terminalBlocks, /formatTerminalBlockCommandAndOutput\(block\.command, output\)/);
  assert.match(terminalBlocks, /writeText\(block\.command\)/);
  assert.match(terminalBlocks, /return true/);
  assert.match(terminalBlocks, /catch \{[\s\S]*return false/);
  assert.match(terminalBlocks, /term\.onScroll/);
  assert.match(terminalBlocks, /e\.key === "ArrowUp"[\s\S]*navigateBlock\("previous"\)/);
  assert.match(terminalBlocks, /e\.key === "ArrowDown"[\s\S]*navigateBlock\("next"\)/);
  assert.match(terminalBlocks, /navigator\.clipboard\.writeText/);
  assert.match(terminalBlocksBar, /export function TerminalBlocksBar/);
  assert.match(terminalBlocksBar, /type CopyBlockResult = boolean \| Promise<boolean>/);
  assert.match(terminalBlocksBar, /import \{ ContextMenu, type MenuEntry \} from "\.\/ContextMenu"/);
  assert.match(terminalBlocksBar, /title="复制命令"[\s\S]*onCopy=\{onCopyCommand\}/);
  assert.match(terminalBlocksBar, /title="复制输出"[\s\S]*onCopy=\{onCopyOutput\}/);
  assert.match(terminalBlocksBar, /id: "block:copy-both"[\s\S]*label: "复制命令和输出"[\s\S]*onCopyCommandAndOutput/);
  assert.match(terminalBlocksBar, /id: "block:filter-output"[\s\S]*label: "筛选输出"[\s\S]*icon: "search"/);
  assert.match(terminalBlocksBar, /onFilterBlock: \(block: TerminalCommandBlock\) => void/);
  assert.match(terminalBlocksBar, /onContextMenu=\{\(e\) => \{[\s\S]*setContextMenu/);
  assert.match(terminalBlocksBar, /const copySucceeded = await Promise\.resolve\(onCopy\(id\)\)\.catch\(\(\) => false\)/);
  assert.match(terminalBlocksBar, /if \(!copySucceeded\) return;[\s\S]*setCopied\(true\)/);
  assert.match(terminalBlocksBar, /当前输出/);
  assert.match(terminalBlocksBar, /stickyBlock/);
  assert.match(terminalBlocksBar, /const visibleBlocks = blocks\.slice\(-5\)\.reverse\(\)/);
  assert.match(terminalBlocksBar, /completed=\{completed\}/);
  assert.match(terminalBlocksBar, /disabled=\{!completed\}/);
  assert.match(terminalBlocksBar, /运行/);
  assert.doesNotMatch(terminalBlocksBar, /code === 0 \|\| code === undefined/);
  assert.match(terminalBufferRead, /export function extractCommandFromBuffer/);
  assert.match(terminalBufferRead, /export function extractCommandFromOsc/);
  assert.match(terminalBufferRead, /export function getTerminalTailText/);
  assert.match(terminalCodexState, /export function createCodexScreenStateTracker/);
  assert.match(terminalCodexState, /CODEX_DATA_BURST_BUSY_THRESHOLD/);
  assert.match(terminalCodexState, /detectCodexScreenState\(tail\)/);
  assert.match(terminalCommand, /export function isMeaningfulCommand/);
  assert.match(terminalFont, /export const TERMINAL_FONT_LOAD_TIMEOUT_MS = 200/);
  assert.match(terminalFont, /export function buildTerminalFontFamily/);
  assert.match(terminalFont, /export async function waitForTerminalFontReady/);
  assert.match(terminal, /waitForTerminalFontReady\(\{ fontSize, fontFamily, nerdFontFallback \}\)/);
  assert.match(terminalInstance, /export function createTerminalInstance/);
  assert.match(terminalOutput, /export function createTerminalOutputBuffer/);
  assert.match(terminalPending, /export function schedulePendingInput/);
  assert.match(terminalSnapshotScheduler, /export function createTerminalSnapshotScheduler/);
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
