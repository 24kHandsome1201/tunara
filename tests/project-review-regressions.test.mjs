import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  assert.match(sidebar, /const canReorder = q\.length === 0/);
  assert.match(sidebar, /if \(!canReorder\) return;/);
  assert.match(toast, /exitTimerRef/);
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

  assert.match(settings, /CLI 路径检测失败/);
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
  assert.doesNotMatch(sidebar, /onClearCloseConfirm/);
  assert.doesNotMatch(sidebar, /clearDirCloseConfirmation/);
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
  const palette = read("src/ui/overlays/CommandPalette.tsx");
  const contextMenu = read("src/ui/ContextMenu.tsx");
  const globals = read("src/styles/globals.css");

  assert.match(titlebar, /width: 20, height: 20/);
  assert.match(titlebar, /paddingLeft: 8/);
  assert.match(sidebar, /padding: "8px 12px 6px"/);
  assert.match(sidebarHeader, /padding: "6px 9px"/);
  assert.match(sessionCard, /transition: "opacity var\(--duration-fast\) ease"/);
  assert.match(sessionCard, /paddingLeft: 6/);
  assert.match(main, /"1px solid var\(--c-accent\)"/);
  assert.match(status, /\}, 1500\)/);
  assert.match(status, /transition: "opacity 0\.3s ease"/);
  assert.match(settings, /gridTemplateColumns: "repeat\(auto-fit, minmax\(118px, 1fr\)\)"/);
  assert.match(diff, /function remoteLabel\(remote: RemoteState \| null\): string/);
  assert.match(diff, /Git 状态未知/);
  assert.match(explorer, /function compactRelativePath/);
  assert.match(explorer, /minWidth: 48, textAlign: "right"/);
  assert.doesNotMatch(palette, /width: 3,[\s\S]*height: "60%"/);
  assert.match(globals, /@keyframes ctxMenuIn/);
  assert.match(contextMenu, /ctxMenuIn var\(--duration-fast\) ease/);
});

test("review follow-up keeps terminal and sidebar hotspots split into focused pieces", () => {
  const terminal = read("src/ui/TerminalView.tsx");
  const terminalSearch = read("src/ui/TerminalSearchBar.tsx");
  const sidebar = read("src/ui/Sidebar.tsx");
  const sidebarHeader = read("src/ui/SidebarDirGroupHeader.tsx");

  assert.match(terminal, /import \{ TerminalSearchBar \} from "\.\/TerminalSearchBar"/);
  assert.match(terminalSearch, /export function TerminalSearchBar/);
  assert.match(sidebar, /import \{ DirGroupHeader, SidebarSearchIcon \} from "\.\/SidebarDirGroupHeader"/);
  assert.match(sidebarHeader, /export function DirGroupHeader/);

  assert.ok(terminal.split("\n").length < 700);
  assert.ok(sidebar.split("\n").length < 380);
});
