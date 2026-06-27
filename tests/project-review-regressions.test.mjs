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
  const cask = read("homebrew/tunara.rb");
  const changelog = read("CHANGELOG.md");

  const version = pkg.version;
  assert.equal(tauri.version, version);
  assert.match(cargo, new RegExp(`^version = "${version}"$`, "m"));
  assert.match(lock, new RegExp(`name = "tunara"\\nversion = "${version}"`));
  assert.match(cask, new RegExp(`version "${version}"`));
  assert.match(changelog, new RegExp(`## \\[${version}\\]`));

  assert.equal(tauri.identifier, "dev.tunara.app");
  assert.match(cask, /github\.com\/24kHandsome1201\/tunara/);
  assert.doesNotMatch(cask, /github\.com\/mawei\/tunara/);
  assert.doesNotMatch(cask, /PLACEHOLDER_SHA256/);
  assert.doesNotMatch(cask, /com\.tunara\.app/);
  assert.match(cask, /Application Support\/dev\.tunara\.app/);
  assert.match(tauri.plugins.updater.endpoints[0], /github\.com\/24kHandsome1201\/tunara/);
});

test("mac window chrome aligns controls and hides main window on close while cleaning up on exit", () => {
  const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
  const lib = read("src-tauri/src/lib.rs");
  const defaultCapability = JSON.parse(read("src-tauri/capabilities/default.json"));

  assert.equal(tauri.app.windows[0].titleBarStyle, "Overlay");
  assert.deepEqual(tauri.app.windows[0].trafficLightPosition, { x: 18, y: 18 });
  assert.ok(defaultCapability.permissions.includes("core:window:allow-hide"));
  assert.match(lib, /tauri::RunEvent::Reopen \{[\s\S]*?has_visible_windows: false,[\s\S]*?window\.show\(\)[\s\S]*?window\.set_focus\(\)/);
  assert.match(lib, /tauri::RunEvent::Exit[\s\S]*?app\.state::<pty::PtyState>\(\)\.close_all\(\);[\s\S]*?app\.state::<HookListenerState>\(\)\.shutdown\(\);/);
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
  const cargo = read("src-tauri/Cargo.toml");
  const modules = read("src-tauri/src/modules/mod.rs");
  const lib = read("src-tauri/src/lib.rs");
  const security = read("SECURITY.md");
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
  assert.match(cargo, /^toml_edit = "0\.20"$/m);
  assert.match(modules, /pub mod config;/);
  assert.match(lib, /modules::config::load_config/);
  assert.match(lib, /modules::config::save_config/);
  assert.match(configRs, /\.join\("\.config"\)[\s\S]*\.join\("tunara"\)[\s\S]*\.join\("config\.toml"\)/);
  assert.match(configRs, /const LEGACY_CONFIG_DIR: &str = "conduit";/);
  assert.match(configRs, /migrate_legacy_config_if_needed/);
  assert.match(configRs, /fs::copy\(legacy_path, path\)/);
  assert.match(configRs, /fs::rename\(&tmp, path\)/);
  assert.match(configRs, /use toml_edit::\{value, Document, Item, Table\}/);
  assert.match(configRs, /merge_known_config/);
  assert.match(configRs, /MAX_SCROLLBACK: u32 = 20_000/);
  assert.doesNotMatch(configRs, /MAX_PANEL_WIDTH/);
  assert.match(configRs, /upper bound is viewport-dependent in src\/state\/ui\.ts/);
  assert.match(configRs, /Err\(_\) => serialize_new_config\(&config\)\?/);
  assert.match(configRs, /config\.clamp\(\)/);
  assert.match(configRs, /pub font_ligatures: bool/);
  assert.match(configRs, /font_ligatures: false/);
  assert.match(configRs, /pub terminal_clipboard_write: bool/);
  assert.match(configRs, /terminal_clipboard_write: false/);
  assert.match(security, /OSC 52 clipboard writes are disabled by default/);
  assert.match(security, /terminal_clipboard_write = true/);
  assert.match(security, /does not implement clipboard read responses/);
  assert.match(configRs, /\("quick_select", "Mod\+Shift\+Space"\)/);
  const defaultConfigKeys = [...configRs.matchAll(/\("([a-z0-9_]+)", "Mod\+[^"]+"\)/g)].map((m) => m[1]);
  assert.equal(new Set(defaultConfigKeys).size, defaultConfigKeys.length);
  assert.match(bridge, /invoke<LoadedTunaraConfig>\("load_config"\)/);
  assert.match(bridge, /invoke\("save_config", \{ config \}\)/);
  assert.match(bridge, /font_ligatures: boolean/);
  assert.match(bridge, /terminal_clipboard_write: boolean/);
  assert.match(keybindings, /export const DEFAULT_KEYBINDINGS/);
  assert.match(keybindings, /newTerminalAlt: "Mod\+N"/);
  assert.match(keybindings, /quickSelect: "Mod\+Shift\+Space"/);
  assert.match(keybindings, /export function hasPlatformModKey/);
  assert.match(keybindings, /export function matchesKeybinding/);
  assert.match(keybindings, /const modPressed = hasPlatformModKey\(e, isMac\)/);
  assert.match(ui, /loadTunaraConfig/);
  assert.match(ui, /saveTunaraConfig\(settingsToRawConfig/);
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
  const zhDictForLigatures = read("src/modules/i18n/locales/zh-CN.json");
  assert.match(settings, /t\("settings\.appearance\.ligatures"\)/);
  assert.match(zhDictForLigatures, /"settings\.appearance\.ligatures": "连字"/);
  assert.match(settings, /configPath/);
});

test("session persistence keeps custom titles and rejects invalid stored payloads", () => {
  const persist = read("src/state/persist.ts");
  assert.match(persist, /const STORE_FILE = "tunara-sessions\.json";/);
  assert.match(persist, /const LEGACY_STORE_FILE = "conduit-sessions\.json";/);
  assert.match(persist, /async function loadSessionStore\(\): Promise<SessionStore>/);
  assert.match(persist, /legacyStore\.entries<unknown>\(\)/);
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
  assert.match(explorer, /fsSearch\(baseDir, q, 80, includeHidden\)/);
  assert.match(explorer, /setReloadKey\(\(n\) => n \+ 1\)/);
  assert.match(explorer, /setIncludeHidden\(\(v\) => !v\)/);
  assert.match(explorer, /placeholder=\{isRemote \? t\("explorer\.search_remote_unavailable"\) : t\("explorer\.search_placeholder"\)\}/);
  assert.match(explorer, /disabled=\{isRemote\}/);
  assert.match(explorer, /items: isRemote[\s\S]*?id: "dir:copy-path"/);
  assert.match(explorer, /items: isRemote[\s\S]*?id: "file:copy-path"/);
  const zhDictForExplorer = read("src/modules/i18n/locales/zh-CN.json");
  assert.match(zhDictForExplorer, /"explorer\.search_placeholder": "搜索当前项目"/);
  assert.match(zhDictForExplorer, /"explorer\.search_remote_unavailable": "远程搜索暂未支持"/);
  assert.match(search, /#\[serde\(rename_all = "camelCase"\)\]/);
  assert.match(search, /include_hidden: Option<bool>/);
  assert.match(search, /\.hidden\(!include_hidden\)/);
  assert.match(tree, /include_hidden: Option<bool>/);
});

test("pure SSH host mapping avoids importing the Tauri IPC bridge", () => {
  const bridge = read("src/modules/ssh/hosts-bridge.ts");
  const model = read("src/modules/ssh/hosts-model.ts");
  const sshLogicTest = read("tests/ssh-logic.test.mjs");

  assert.match(bridge, /from "\.\/hosts-model\.ts"/);
  assert.doesNotMatch(model, /@tauri-apps\/api/);
  assert.match(sshLogicTest, /from "\.\.\/src\/modules\/ssh\/hosts-model\.ts"/);
});

test("pure UI helpers avoid importing the React-bound i18n entry", () => {
  const types = read("src/ui/types.ts");
  const i18nCore = read("src/modules/i18n/core.ts");
  const i18nIndex = read("src/modules/i18n/index.ts");

  assert.match(types, /from "\.\.\/modules\/i18n\/core\.ts"/);
  assert.doesNotMatch(i18nCore, /from "react"/);
  assert.match(i18nIndex, /from "\.\/core\.ts"/);
});

test("git sidebar state is single-sourced and distinguishes non-repo directories", () => {
  const types = read("src/ui/types.ts");
  const main = read("src/ui/MainArea.tsx");
  const diff = read("src/ui/DiffPanel.tsx");
  const lifecycle = read("src/modules/terminal/lib/session-lifecycle.ts");

  assert.match(types, /export type GitState = "unknown" \| "repo" \| "notGit";/);
  assert.match(types, /gitState\?: GitState;/);
  assert.match(main, /activeIsRemote/);
  assert.match(main, /gitState: "repo"/);
  assert.match(main, /gitState: "notGit"/);
  assert.match(lifecycle, /gitState: "unknown"/);
  assert.match(diff, /session\.changes\?\.files \?\? \[\]/);
  assert.match(diff, /session\.gitState === "notGit"/);
  assert.match(diff, /diffGenerationRef/);
  assert.match(diff, /repoPathRef\.current === requestedRepoPath/);
  assert.match(diff, /useSessionsStore\.getState\(\)\.refreshGit\(session\.id\)/);
  assert.doesNotMatch(diff, /\bgitStatus\b/);
});

test("session persistence is debounced and still flushed on close", () => {
  const init = read("src/app/useInit.ts");
  assert.match(init, /let saveTimer: ReturnType<typeof setTimeout> \| null = null/);
  assert.match(init, /const scheduleSave = \(\) => \{/);
  assert.match(init, /setTimeout\(\(\) => \{[\s\S]*?persistNow\(\);[\s\S]*?\}, 500\)/);
  assert.match(init, /scheduleSave\(\);/);
  // 30s backstop flush is gated on the terminal-snapshot dirty flag, so an idle
  // or hidden app with no new output performs no redundant serialize + disk write.
  assert.match(init, /setInterval\(\(\) => \{[\s\S]*?if \(consumeTerminalSnapshotDirty\(\)\) persistNow\(\);[\s\S]*?\}, 30_000\)/);
  assert.match(init, /onCloseRequested\(async \(event\) => \{[\s\S]*?event\.preventDefault\(\);[\s\S]*?clearTimeout\(saveTimer\);[\s\S]*?await saveWorkspaceSnapshot[\s\S]*?await win\.hide\(\)/);
});

test("terminal snapshot writes flip a dirty flag the persist backstop consumes", () => {
  const snap = read("src/modules/terminal/lib/terminal-snapshot.ts");
  // The dirty flag is the contract that lets the 30s backstop skip redundant
  // writes: output (update) and session removal must set it; restore (loading
  // from disk) must NOT, since that data was just persisted.
  assert.match(snap, /export function consumeTerminalSnapshotDirty\(\): boolean \{/);
  assert.match(snap, /export function updateTerminalSnapshot\([\s\S]*?dirty = true;/);
  assert.match(snap, /if \(snapshots\.delete\(sessionId\)\) dirty = true;/);
  assert.doesNotMatch(snap, /restoreTerminalSnapshots[\s\S]*?dirty = true/);
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
  assert.match(init, /if \(s\.remote\) p\.remote = s\.remote/);
  assert.match(init, /gitWatchDirsForSessions\(sessions\)/);
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
  // Single stable-keyed mount list rendering a memoized TerminalPane (extracted
  // so MainArea re-renders on agent heartbeats don't re-render every terminal).
  assert.match(main, /mountedSessions\.map\(\(s\) => \([\s\S]*?key=\{s\.id\}[\s\S]*?<TerminalPane session=\{s\} isActive=\{s\.id === activeSessionId\} \/>/);
  assert.match(main, /const TerminalPane = memo\(function TerminalPane/);
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
  const zhDict = read("src/modules/i18n/locales/zh-CN.json");

  assert.match(ui, /function clampNumber\(value: unknown/);
  assert.match(ui, /function sanitizeAccent\(value: unknown\)/);
  assert.match(ui, /setAccent: \(accent\) => set\(\{ accent: sanitizeAccent\(accent\) \}\)/);
  assert.match(ui, /setSidebarVisible: \(sidebarVisible\) => set\(\{ sidebarVisible \}\)/);
  assert.match(ui, /setPanelVisible: \(panelVisible\) => set\(\{ panelVisible \}\)/);
  assert.match(ui, /setExternalEditor: \(externalEditor\) => set\(\{ externalEditor: isExternalEditor\(externalEditor\)/);
  assert.match(palette, /label: t\("palette\.cmd\.new_terminal_current_dir"\)/);
  assert.match(palette, /label: t\("palette\.cmd\.refresh_git_current"\)/);
  assert.match(palette, /label: t\("palette\.cmd\.close_current_session"\)/);
  assert.match(zhDict, /"palette\.cmd\.new_terminal_current_dir": "在当前目录新建终端"/);
  assert.match(zhDict, /"palette\.cmd\.refresh_git_current": "刷新当前 Git 状态"/);
  assert.match(zhDict, /"palette\.cmd\.close_current_session": "关闭当前会话"/);
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
  const contributing = read("CONTRIBUTING.md");
  const shared = read("src/ui/shared.tsx");

  assert.match(html, /var accent = "#c2683c"/);
  assert.doesNotMatch(html, /localStorage/);
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
  assert.match(contributing, /批量启动入口/);

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

  const zhDict = read("src/modules/i18n/locales/zh-CN.json");
  assert.match(settings, /t\("settings\.cli\.error"\)/);
  assert.match(zhDict, /"settings\.cli\.error": "CLI 路径检测失败"/);
  assert.match(settings, /const loadCliStatus = useCallback/);
  assert.match(settings, /onClick=\{loadCliStatus\}/);
  assert.match(settings, /<RefreshIcon size=\{12\} \/>/);
  assert.match(settings, /t\("settings\.cli\.path_label"\)/);
  assert.match(zhDict, /"settings\.cli\.path_label": "CLI 路径"/);
  assert.match(settings, /t\("settings\.cli\.found", \{ count: installedCliCount, total: CLI_LIST\.length \}\)/);
  assert.match(settings, /t\("settings\.cli\.not_on_path"\)/);
  assert.match(zhDict, /"settings\.cli\.not_on_path": "未在当前应用 PATH 中找到"/);
  assert.match(settings, /activeTab === "appearance"/);
  assert.match(settings, /onClick=\{\(\) => useUIStore\.getState\(\)\.resetAppearance\(\)\}/);
  assert.match(ui, /resetAppearance: \(\) => set\(\(s\) => \(\{ \.\.\.DEFAULT_SETTINGS, keybindings: s\.keybindings, language: s\.language \}\)\)/);
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
  const sidebarMenu = read("src/ui/sidebar-session-menu.ts");
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
  const zhDict = read("src/modules/i18n/locales/zh-CN.json");
  assert.match(sidebarMenu, /label: t\("sidebar\.session\.rename"\), icon: "rename"/);
  assert.match(sidebarMenu, /label: t\("sidebar\.session\.close"\), icon: "close"/);
  assert.match(sidebar, /label: t\("sidebar\.dir\.close_all"\), icon: "close"/);
  assert.match(zhDict, /"sidebar\.session\.rename": "重命名"/);
  assert.match(zhDict, /"sidebar\.session\.close": "关闭会话"/);
  assert.match(zhDict, /"sidebar\.dir\.close_all": "关闭全部会话"/);
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
  assert.match(titlebar, /const MAC_TITLEBAR_CONTROL_Y_OFFSET = -7/);
  assert.match(titlebar, /const titlebarControlTransform = _isMac \? `translateY\(\$\{MAC_TITLEBAR_CONTROL_Y_OFFSET\}px\)` : undefined/);
  assert.equal(titlebar.match(/transform: titlebarControlTransform/g)?.length, 3);
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
  assert.match(sidebar, /aria-label=\{t\("sidebar\.list\.aria_label"\)\}/);
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
  // focus ring may be implemented via boxShadow (inset) or outline (external) — both convey focused visual state
  assert.match(sessionCard, /(?:boxShadow|outline): focused \?/);
  assert.match(sessionCard, /function TerminalProgressBar/);
  assert.match(sessionCard, /session\.terminalProgress && <TerminalProgressBar/);
  assert.match(main, /inset 0 2px 0 var\(--c-accent\)/);
  assert.match(main, /inset 2px 0 0 var\(--c-accent\)/);
  assert.doesNotMatch(main, /outline: .*var\(--c-accent\)/);
  assert.match(main, /function SplitIcon/);
  // Split-control labels are localized via i18n (no hardcoded Chinese in the component).
  assert.match(main, /title=\{t\("split\.horizontal_with_shortcut"\)\}/);
  assert.match(main, /title=\{t\("split\.vertical_with_shortcut"\)\}/);
  assert.match(main, /aria-label=\{t\("split\.horizontal"\)\}/);
  assert.doesNotMatch(main, /左右分栏|上下分栏|关闭分栏/);
  // Idle→fade delay (was 1500ms transition; now 1200ms delay before sliding out via keyframe)
  assert.match(status, /setFading\(true\), 1200\)/);
  // Exit animation now uses a keyframe ('statusBarSlideOut') driven by onAnimationEnd instead of an opacity/transform transition
  assert.match(status, /statusBarSlideOut var\(--duration-fast\)/);
  assert.match(status, /onAnimationEnd=\{/);
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
  // buildMiniDiffRows now lives in src/ui/lib/diff-parse.ts and is consumed via import.
  const diffParseModule = read("src/ui/lib/diff-parse.ts");
  assert.match(diffParseModule, /export function buildMiniDiffRows\(patch: string\)/);
  assert.match(diff, /import \{ buildMiniDiffRows, collectHunkTexts, filterRowsByQuery \} from "\.\/lib\/diff-parse"/);
  assert.doesNotMatch(diff, /lines\.map\(\(line, i\)/);
  // DiffPanel is fully i18n-wired — UI literals route through t() / staticT and live in the dictionaries.
  assert.match(diff, /import \{ useT, t as staticT \} from "@\/modules\/i18n"/);
  assert.match(diff, /staticT\("diff\.remote\.unknown"\)/);
  const zhDictForDiff = read("src/modules/i18n/locales/zh-CN.json");
  const enDictForDiff = read("src/modules/i18n/locales/en.json");
  assert.match(zhDictForDiff, /"diff\.remote\.unknown": "Git 状态未知"/);
  assert.match(enDictForDiff, /"diff\.remote\.unknown": "Git status unknown"/);
  // Truncated hint must render whenever the diff is truncated — including under a no-match search.
  assert.match(diff, /diff\.truncated && <div[^>]*>\{t\("diff\.mini\.truncated"\)\}<\/div>/);
  assert.doesNotMatch(diff, /diff\.truncated && !q/);
  // Search input is IME-safe: composition events gate setSearchQuery so CJK typing doesn't flicker.
  assert.match(diff, /isComposingRef = useRef\(false\)/);
  assert.match(diff, /onCompositionStart=\{\(\) => \{ isComposingRef\.current = true; \}\}/);
  assert.match(diff, /onCompositionEnd=\{/);
  assert.match(diff, /if \(isComposingRef\.current\) return;\s*setSearchQuery\(e\.target\.value\)/);
  assert.match(diff, /if \(e\.nativeEvent\.isComposing\) return;/);
  assert.match(diff, /className="no-scrollbar scroll-fade-y"/);
  assert.match(explorer, /function compactRelativePath/);
  assert.match(explorer, /className="no-scrollbar scroll-fade-y"/);
  const zhDict = read("src/modules/i18n/locales/zh-CN.json");
  assert.match(explorer, /label: t\("sidebar\.dir\.new_terminal"\), icon: "terminal"/);
  assert.match(explorer, /label: t\("sidebar\.dir\.copy_path"\), icon: "copy"/);
  assert.match(zhDict, /"sidebar\.dir\.new_terminal": "在此目录新建终端"/);
  assert.match(zhDict, /"sidebar\.dir\.copy_path": "复制路径"/);
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
  const terminalBlocksPure = read("src/modules/terminal/lib/terminal-blocks.ts");
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
  assert.match(terminal, /import \{ createInputQueueFullWarner, emitTerminalNotification, requestInformationalAttention, safeDispose \} from "\.\/terminal-attention"/);
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
  assert.match(terminal, /term\.attachCustomKeyEventHandler\(\(e\) => handleCopyKeyEvent\(term, e\) && search\.handleCustomKeyEvent\(e\) && blocks\.handleCustomKeyEvent\(e\)\)/);
  assert.match(terminal, /import \{ handleCopyKeyEvent \} from "@\/modules\/terminal\/lib\/terminal-copy"/);
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
  assert.match(terminalChrome, /onContextMenu=\{handleContextMenu\}/);
  assert.match(terminalChrome, /term\.paste\(text\)/);
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
  const zhDict = read("src/modules/i18n/locales/zh-CN.json");
  assert.match(commandPalette, /id: "quick-select-visible-output"/);
  assert.match(commandPalette, /label: t\("palette\.cmd\.quick_select"\)/);
  assert.match(zhDict, /"palette\.cmd\.quick_select": "快速选择附近输出"/);
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
  assert.match(terminalBlocksPure, /export function findStickyCommandBlock/);
  assert.match(terminalBlocksPure, /export function findNavigableCommandBlock/);
  assert.match(terminalBlocksPure, /export function normalizeBlockCommand/);
  assert.match(terminalBlocksPure, /export function collectTerminalBlockOutputText/);
  assert.match(terminalBlocksPure, /export function formatTerminalBlockCommandAndOutput/);
  assert.match(terminalBlocks, /import \{ matchesKeybinding \} from "\.\.\/modules\/config\/keybindings\.ts"/);
  assert.match(terminalBlocks, /import \{ useUIStore \} from "@\/state\/ui"/);
  assert.match(terminalBlocks, /function detectMacPlatform\(\): boolean/);
  assert.match(terminalBlocks, /matchesKeybinding\(e, bindings\.navigatePrevBlock, isMac\)/);
  assert.match(terminalBlocks, /matchesKeybinding\(e, bindings\.navigateNextBlock, isMac\)/);
  assert.doesNotMatch(terminalBlocks, /@tauri-apps\/plugin-os/);
  assert.doesNotMatch(terminalBlocks, /slice\(0, 77\) \+ "\.\.\."/);
  assert.match(terminalBlocksPure, /rows\.startRow \+ 1/);
  assert.match(terminalBlocks, /readBlockOutputText/);
  assert.match(terminalBlocks, /const copyBlockOutput = useCallback\(async \(id: string\): Promise<boolean> =>/);
  assert.match(terminalBlocks, /const output = readBlockOutput\(id\)/);
  assert.match(terminalBlocks, /if \(output === null \|\| output\.length === 0\) return false/);
  assert.match(terminalBlocks, /writeText\(output\)/);
  assert.match(terminalBlocks, /resolveTerminalBlockRows/);
  assert.match(terminalBlocks, /term\.registerMarker/);
  assert.match(terminalBlocks, /block\.endMarker !== block\.startMarker/);
  assert.match(terminalBlocksPure, /export function resolveTerminalBlockRows/);
  assert.match(terminalBlocks, /const copyBlockCommand = useCallback\(async \(id: string\): Promise<boolean> =>/);
  assert.match(terminalBlocks, /const copyBlockCommandAndOutput = useCallback\(async \(id: string\): Promise<boolean> =>/);
  assert.match(terminalBlocks, /const readBlockOutput = useCallback\(\(id: string\): string \| null =>/);
  assert.match(terminalBlocks, /return readBlockOutputText\(term, block\)/);
  assert.match(terminalBlocks, /formatTerminalBlockCommandAndOutput\(block\.command, output\)/);
  assert.match(terminalBlocks, /writeText\(block\.command\)/);
  assert.match(terminalBlocks, /return true/);
  assert.match(terminalBlocks, /catch \{[\s\S]*return false/);
  assert.match(terminalBlocks, /term\.onScroll/);
  assert.match(terminalBlocks, /matchesKeybinding\(e, bindings\.navigatePrevBlock, isMac\)[\s\S]*navigateBlock\("previous"\)/);
  assert.match(terminalBlocks, /matchesKeybinding\(e, bindings\.navigateNextBlock, isMac\)[\s\S]*navigateBlock\("next"\)/);
  assert.match(terminalBlocks, /navigator\.clipboard\.writeText/);
  assert.match(terminalBlocksBar, /export function TerminalBlocksBar/);
  assert.match(terminalBlocksBar, /type CopyBlockResult = boolean \| Promise<boolean>/);
  assert.match(terminalBlocksBar, /import \{ ContextMenu \} from "\.\/ContextMenu"/);
  assert.match(terminalBlocksBar, /import \{ buildBlockContextMenuItems \} from "@\/modules\/terminal\/lib\/terminal-blocks-menu"/);
  assert.match(terminalBlocksBar, /className="cmd-chip"/);
  assert.match(terminalBlocksBar, /className="cmd-chip-more"/);
  assert.match(terminalBlocksBar, /buildBlockContextMenuItems\(contextMenu\.block, contextMenu\.completed, contextMenu\.collapsed/);
  assert.match(terminalBlocksBar, /onFilterBlock: \(block: TerminalCommandBlock\) => void/);
  assert.match(terminalBlocksBar, /const openContextMenu = \([\s\S]*setContextMenu/);
  assert.match(terminalBlocksBar, /onContextMenu=\{\(e\) => \{[\s\S]*openContextMenu\(stickyBlock/);
  assert.match(terminalBlocksBar, /openContextMenu\(block, completed, collapsed/);
  // Block status / current-output labels are localized via i18n (no hardcoded Chinese).
  assert.match(terminalBlocksBar, /t\("block\.current_output"\)/);
  assert.match(terminalBlocksBar, /stickyBlock/);
  assert.match(terminalBlocksBar, /const visibleBlocks = blocks\.slice\(-5\)\.reverse\(\)/);
  assert.match(terminalBlocksBar, /completed=\{completed\}/);
  assert.match(terminalBlocksBar, /t\("block\.status\.running"\)/);
  assert.doesNotMatch(terminalBlocksBar, /当前输出|更多操作/);
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

  // Keep these hotspots focused (they were split out of a monolith). Bumped
  // from 500→520 for TerminalView when it gained React.memo + the ptyReady gate
  // that fixed the double-submit bug; still a guard against re-monolithizing.
  assert.ok(terminal.split("\n").length < 520);
  assert.ok(sidebar.split("\n").length < 400);
});
