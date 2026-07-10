import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

test("dead IPC commands are removed from the Tauri invoke handler", () => {
  const lib = read("src-tauri/src/lib.rs");

  assert.doesNotMatch(lib, /fs::tree::list_subdirs/);
  assert.doesNotMatch(lib, /fs::file::fs_stat/);
  assert.doesNotMatch(lib, /fs::grep::fs_glob/);
  assert.doesNotMatch(lib, /modules::resolver::resolve_bin/);
  assert.match(lib, /modules::resolver::resolve_all_bins/);
  assert.match(lib, /modules::resolver::set_bin_override/);
});

test("node test script can import TypeScript sources on Node 22", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.match(pkg.scripts["test:node"], /--experimental-strip-types/);
  assert.match(pkg.scripts.test, /pnpm test:node/);
});

test("CI enforces Tauri npm/cargo major.minor version coupling", () => {
  const scriptPath = resolve(root, "scripts/check-tauri-version-coupling.sh");
  const ci = read(".github/workflows/ci.yml");
  const script = read("scripts/check-tauri-version-coupling.sh");

  assert.ok(existsSync(scriptPath), "scripts/check-tauri-version-coupling.sh must exist");
  assert.match(ci, /pnpm install --frozen-lockfile/);
  assert.match(ci, /check-tauri-version-coupling\.sh/);
  assert.match(script, /@tauri-apps\/api/);
  assert.match(script, /src-tauri\/Cargo\.lock/);
  assert.match(script, /major\.minor|NPM_MM|CARGO_MM/);
});

test("release metadata keeps versions and distribution identifiers aligned", () => {
  const pkg = JSON.parse(read("package.json"));
  const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
  const cargo = read("src-tauri/Cargo.toml");
  const lock = read("src-tauri/Cargo.lock");
  const cask = read("Casks/tunara.rb");
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

test("release stays draft until direct, legacy, and updater assets are complete", () => {
  const release = read(".github/workflows/release.yml");

  assert.match(release, /prepare-release:[\s\S]*?gh release create "\$TAG" "\$\{release_args\[@\]\}"/);
  assert.match(release, /releaseDraft: true/);
  assert.doesNotMatch(release, /releaseDraft: false/);
  assert.match(release, /finalize-release:[\s\S]*?needs:[\s\S]*?- publish-tauri[\s\S]*?- publish-legacy/);
  assert.match(release, /required_assets=\([\s\S]*?aarch64\.dmg[\s\S]*?aarch64-legacy\.dmg[\s\S]*?latest\.json/);
  assert.match(release, /gh release edit "\$TAG" --draft=false/);
  assert.match(release, /DMG_NAME="Tunara_\$\{TAG\}_aarch64\.dmg"/);
  assert.doesNotMatch(release, /select\(\.name \| test\("Tunara_\.\*\\\\\.dmg"\)\)/);
  assert.match(release, /Casks\/tunara\.rb/);
  assert.equal(existsSync(resolve(root, "homebrew/tunara.rb")), false);
});

test("SSH reconnect is transactional and host-key prompts fail closed", () => {
  const ssh = read("src-tauri/src/modules/ssh/mod.rs");
  const connection = read("src-tauri/src/modules/ssh/connection.rs");
  const auth = read("src-tauri/src/modules/ssh/auth.rs");

  const openIndex = ssh.indexOf("SshSession::open(params, on_event)");
  const insertIndex = ssh.indexOf("state.insert(", openIndex);
  assert.ok(openIndex >= 0 && insertIndex > openIndex, "replacement must happen after a successful SSH open");
  assert.equal(ssh.slice(0, openIndex).includes("state.remove_logical"), false);
  assert.match(connection, /HOST_KEY_PROMPT_TIMEOUT: Duration = Duration::from_secs\(120\)/);
  assert.match(connection, /SSH_TCP_CONNECT_TIMEOUT: Duration = Duration::from_secs\(15\)/);
  assert.match(connection, /tokio::time::timeout\([\s\S]*SSH_TCP_CONNECT_TIMEOUT[\s\S]*TcpStream::connect/);
  assert.match(connection, /client::connect_stream\(config, socket, handler\)/);
  assert.match(connection, /tokio::time::timeout\(timeout, receiver\)/);
  assert.doesNotMatch(connection, /tokio::select! \{\s*biased;[\s\S]{0,300}input_rx\.recv/);

  const explicitKeyIndex = auth.indexOf("if let Some(path) = &opts.identity_file");
  const passwordIndex = auth.indexOf("if let Some(pw) = &opts.password");
  const agentIndex = auth.indexOf("match try_agent(handle, &opts.user).await");
  const noneIndex = auth.indexOf("handle.authenticate_none(&opts.user).await");
  assert.ok(noneIndex >= 0 && explicitKeyIndex > noneIndex, "none authentication probe must run first");
  assert.ok(explicitKeyIndex >= 0 && agentIndex > explicitKeyIndex, "explicit identity must precede agent enumeration");
  assert.ok(passwordIndex > explicitKeyIndex && agentIndex > passwordIndex, "supplied password must precede agent enumeration");
  assert.match(auth, /metadata\.is_file\(\)/);
  assert.match(auth, /MAX_IDENTITY_FILE_BYTES/);
  assert.match(auth, /spawn_blocking/);
});

test("SSH connection state comes from backend phase evidence and remains ephemeral", () => {
  const session = read("src-tauri/src/modules/pty/session.rs");
  const connection = read("src-tauri/src/modules/ssh/connection.rs");
  const bridge = read("src/modules/terminal/lib/pty-bridge.ts");
  const terminal = read("src/ui/TerminalView.tsx");
  const persisted = read("src/state/persist-snapshot.ts");

  assert.match(session, /ConnectionStatus \{\s*phase: String/);
  for (const phase of ["connecting", "handshaking", "authenticating", "openingShell", "ready"]) {
    assert.match(connection, new RegExp(`send_connection_status\\(&on_event, "${phase}"\\)`));
  }
  assert.match(bridge, /onConnectionStatus\?: \(phase: PtyConnectionStatusPhase\)/);
  assert.match(terminal, /recordPtyConnectionStatus/);
  assert.match(bridge, /type: "backendPhase"/);
  assert.match(bridge, /type: "hostKeyPrompt"/);
  assert.match(persisted, /connection: initialConnectionEvidence\(session\.remote \? "ssh" : "local", "restore"\)/);
  assert.doesNotMatch(persisted, /Pick<[\s\S]*?"connection"/);
});

test("remote diff previews cancel superseded SSH exec requests", () => {
  const diff = read("src/ui/DiffPanel.tsx");
  const bridge = read("src/modules/git/git-bridge.ts");
  const remoteGit = read("src-tauri/src/modules/ssh/remote_git.rs");

  assert.match(diff, /activeDiffRequestsRef/);
  assert.match(diff, /cancelGitDiff\(request\.id\)/);
  assert.match(diff, /activeDiffRequestsRef\.current\.get\(key\)\?\.id === requestId/);
  assert.match(bridge, /sshGitDiff\([\s\S]*requestId: string/);
  assert.match(bridge, /invoke<boolean>\("fs_cancel_search", \{ requestId \}\)/);
  assert.match(remoteGit, /pub async fn ssh_git_diff\([\s\S]*request_id: String/);
  assert.match(remoteGit, /exec_cancellable\(&cmd, MAX_DIFF_BYTES \+ 1, cancelled\.clone\(\)\)/);
  assert.match(remoteGit, /search_state\.finish\(&request_id, &cancelled\)/);
});

test("desktop runtime rejects a second process before shared state starts", () => {
  const cargo = read("src-tauri/Cargo.toml");
  const lib = read("src-tauri/src/lib.rs");

  assert.match(cargo, /^tauri-plugin-single-instance = "2"$/m);
  const builderIndex = lib.indexOf("tauri::Builder::default()");
  const singleInstanceIndex = lib.indexOf(".plugin(tauri_plugin_single_instance::init", builderIndex);
  const updaterIndex = lib.indexOf(".plugin(tauri_plugin_updater", builderIndex);
  const setupIndex = lib.indexOf(".setup(|app|", builderIndex);
  assert.ok(singleInstanceIndex > builderIndex && singleInstanceIndex < updaterIndex);
  assert.ok(singleInstanceIndex < setupIndex, "single-instance guard must run before hook/store setup");
  assert.match(lib, /show_main_window\(app, "single-instance"\)/);
});

test("dev app uses a separate macOS identity from release", () => {
  const devTauri = JSON.parse(read("src-tauri/tauri.conf.dev.json"));

  assert.equal(devTauri.identifier, "dev.tunara.app.dev");
  assert.equal(devTauri.productName, "Tuna");
});

test("mac window chrome aligns controls and hides main window on close while cleaning up on exit", () => {
  const tauri = JSON.parse(read("src-tauri/tauri.conf.json"));
  const lib = read("src-tauri/src/lib.rs");
  const defaultCapability = JSON.parse(read("src-tauri/capabilities/default.json"));

  assert.equal(tauri.app.windows[0].titleBarStyle, "Overlay");
  assert.deepEqual(tauri.app.windows[0].trafficLightPosition, { x: 18, y: 18 });
  assert.ok(defaultCapability.permissions.includes("core:window:allow-hide"));
  assert.match(lib, /fn show_main_window\(app: &AppHandle, reason: &str\)/);
  assert.match(lib, /\.setup\(\|app\| \{[\s\S]*?show_main_window\(app\.handle\(\), "setup"\)/);
  assert.match(lib, /tauri::RunEvent::Ready => \{[\s\S]*?show_main_window\(app, "ready"\)/);
  assert.match(lib, /tauri::RunEvent::Reopen \{[\s\S]*?has_visible_windows: false,[\s\S]*?show_main_window\(app, "reopen"\)/);
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
  const agentBadge = read("src/ui/agents/badge.tsx");
  const sessionCard = read("src/ui/SessionCard.tsx");

  assert.match(cargo, /^toml = "1"$/m);
  assert.match(cargo, /^toml_edit = "0\.25"$/m);
  assert.match(modules, /pub mod config;/);
  assert.match(lib, /modules::config::load_config/);
  assert.match(lib, /modules::config::save_config/);
  assert.match(configRs, /\.join\("\.config"\)[\s\S]*\.join\("tunara"\)[\s\S]*\.join\("config\.toml"\)/);
  assert.match(configRs, /const LEGACY_CONFIG_DIR: &str = "conduit";/);
  assert.match(configRs, /migrate_legacy_config_if_needed/);
  assert.match(configRs, /fs::copy\(legacy_path, path\)/);
  assert.match(configRs, /fs::rename\(&tmp, path\)/);
  assert.match(configRs, /CONFIG_WRITE_SEQUENCE\.fetch_add/);
  assert.match(configRs, /use toml_edit::\{value, DocumentMut, Item, Table\}/);
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
  assert.match(keybindings, /function configActionForKey\(key: string\): KeybindingAction \| undefined/);
  assert.match(keybindings, /hasOwnProperty\.call\(CONFIG_KEY_TO_ACTION, key\)/);
  assert.match(keybindings, /export function hasPlatformModKey/);
  assert.match(keybindings, /export function matchesKeybinding/);
  assert.match(keybindings, /const modPressed = hasPlatformModKey\(e, isMac\)/);
  assert.match(ui, /loadTunaraConfig/);
  assert.match(ui, /enqueueConfigSave\(settingsToRawConfig/);
  assert.match(ui, /configPersistQueue = operation\.catch\(\(\) => \{\}\)/);
  assert.match(ui, /\.then\(\(\) => useUIStore\.setState\(\{ configError: null \}\)\)/);
  assert.match(ui, /fontLigatures: false/);
  assert.match(ui, /font_ligatures: s\.fontLigatures/);
  assert.match(ui, /terminalClipboardWrite: false/);
  assert.match(ui, /terminal_clipboard_write: s\.terminalClipboardWrite/);
  assert.match(ui, /persistBootAppearance/);
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
  assert.match(settings, /t\("settings\.appearance\.nerd_font"\)/);
  const zhDictForLigatures = read("src/modules/i18n/locales/zh-CN.json");
  assert.match(settings, /t\("settings\.appearance\.ligatures"\)/);
  assert.match(zhDictForLigatures, /"settings\.appearance\.ligatures": "连字"/);
  assert.match(settings, /configPath/);
  assert.match(agentBadge, /function ownRecordValue<T>\(record: Record<string, T>, key: string\): T \| undefined/);
  assert.match(agentBadge, /hasOwnProperty\.call\(record, key\)/);
  assert.match(agentBadge, /export function getAgentCircleStyle\(agent\?: string\)/);
  assert.match(agentBadge, /export function getAgentIcon\(agent\?: string\)/);
  assert.match(sessionCard, /getAgentCircleStyle\(session\.agent\)/);
  assert.match(sessionCard, /getAgentIcon\(session\.agent\)/);
  assert.doesNotMatch(sessionCard, /AGENT_CIRCLE_STYLES\[session\.agent\]/);
  assert.doesNotMatch(sessionCard, /AGENT_ICONS\[session\.agent\]/);
});

test("settings exposes the signed updater flow and restart permission", () => {
  const settings = read("src/ui/overlays/Settings.tsx");
  const lib = read("src-tauri/src/lib.rs");
  const defaultCapability = JSON.parse(read("src-tauri/capabilities/default.json"));
  const capability = JSON.parse(read("src-tauri/capabilities/desktop.json"));

  assert.match(settings, /check\(\{ timeout: 15_000 \}\)/);
  assert.match(settings, /update\.downloadAndInstall/);
  assert.match(settings, /await relaunch\(\)/);
  assert.match(lib, /tauri_plugin_updater::Builder::new\(\)\.build\(\)/);
  assert.match(lib, /tauri_plugin_process::init\(\)/);
  assert.ok(defaultCapability.permissions.includes("core:app:allow-version"));
  assert.ok(capability.permissions.includes("updater:default"));
  assert.ok(capability.permissions.includes("process:allow-restart"));
});

test("settings defers expensive CLI probes until the CLI tab is opened", () => {
  const settings = read("src/ui/overlays/Settings.tsx");

  assert.match(settings, /const cliLoadStartedRef = useRef\(false\)/);
  assert.match(settings, /if \(activeTab !== "cli" \|\| cliLoadStartedRef\.current\) return;/);
  assert.match(settings, /cliLoadStartedRef\.current = true;[\s\S]*?loadCliStatus\(\)/);
});

test("session persistence keeps custom titles and rejects invalid stored payloads", () => {
  const persist = read("src/state/persist.ts");
  const persistSnapshot = read("src/state/persist-snapshot.ts");
  const persistenceDoc = read("docs/STATE_AND_PERSISTENCE.md");
  const terminalSnapshotLimits = read("src/modules/terminal/lib/terminal-snapshot-limits.ts");
  const init = read("src/app/useInit.ts");
  const ui = read("src/state/ui.ts");
  const diffPanel = read("src/ui/DiffPanel.tsx");
  const sidebar = read("src/ui/Sidebar.tsx");
  const overviewPanel = read("src/ui/SessionOverviewPanel.tsx");
  const recordKeys = read("src/state/record-keys.ts");
  assert.match(persist, /const STORE_FILE = "tunara-sessions\.json";/);
  assert.match(persist, /const LEGACY_STORE_FILE = "conduit-sessions\.json";/);
  assert.match(persist, /async function loadSessionStore\(\): Promise<SessionStore>/);
  assert.match(persist, /legacyStore\.entries<unknown>\(\)/);
  assert.match(persistSnapshot, /function isPersistedSession\(value: unknown\): value is PersistedSession/);
  assert.match(persistSnapshot, /title: p\.title\.trim\(\) \|\| t\("session\.default_title"\)/);
  assert.match(persistSnapshot, /const customTitle = typeof s\.customTitle === "string" \? s\.customTitle\.trim\(\) : ""/);
  assert.match(persistSnapshot, /if \(s\.pinned === true\) p\.pinned = true/);
  assert.match(persistSnapshot, /const customTitle = typeof p\.customTitle === "string" \? p\.customTitle\.trim\(\) : ""/);
  assert.match(persistSnapshot, /customTitle \? \{ customTitle \} : \{\}/);
  assert.match(persistSnapshot, /p\.pinned === true \? \{ pinned: true \} : \{\}/);
  assert.doesNotMatch(persistSnapshot, /if \(s\.customTitle\) p\.customTitle = s\.customTitle/);
  assert.doesNotMatch(persistSnapshot, /if \(s\.pinned\) p\.pinned = true/);
  assert.doesNotMatch(persistSnapshot, /p\.customTitle \? \{ customTitle: p\.customTitle \}/);
  assert.doesNotMatch(persistSnapshot, /p\.pinned \? \{ pinned: true \}/);
  assert.match(persist, /store\.get<unknown>\(SESSIONS_KEY\)/);
  assert.match(persist, /persisted\.every\(isPersistedSession\)/);
  assert.match(persist, /WorkspaceSnapshotLoadResult/);
  assert.match(persist, /status: "loaded"/);
  assert.match(persist, /status: "empty"/);
  assert.match(persist, /status: "error"/);
  assert.match(persist, /workspacePersistenceBlocked = true/);
  assert.match(persist, /store\.reload\(\{ ignoreDefaults: true \}\)/);
  assert.match(persist, /typeof activeId === "string" && sessions\.some\(\(s\) => s\.id === activeId\)/);
  assert.match(persist, /function isPersistedUILayout\(value: unknown\): value is PersistedUILayout/);
  // The legacy per-key save/load helpers (saveSessions/loadSessions/
  // saveUILayout/loadUILayout) were dead code — nothing outside persist.ts
  // referenced them — and have been removed. Legacy keys are read-only
  // migration inputs consumed by loadWorkspaceSnapshot; the ONLY writes are
  // the sanitized workspace snapshot (steady state) and the one-time migrated
  // snapshot. A reintroduced legacy-key write would silently fork the source
  // of truth away from the snapshot.
  assert.doesNotMatch(persist, /export async function saveSessions/);
  assert.doesNotMatch(persist, /export async function loadSessions/);
  assert.doesNotMatch(persist, /export async function saveUILayout/);
  assert.doesNotMatch(persist, /export async function loadUILayout/);
  assert.doesNotMatch(persist, /store\.set\(SESSIONS_KEY/);
  assert.doesNotMatch(persist, /store\.set\(ACTIVE_KEY/);
  assert.doesNotMatch(persist, /store\.set\(UI_LAYOUT_KEY/);
  assert.match(persist, /await store\.set\(WORKSPACE_SNAPSHOT_KEY, migrated\)/);
  assert.match(persist, /saveWorkspaceSnapshot\(snapshot: WorkspaceSnapshotV1\): Promise<WorkspaceSnapshotSaveResult>/);
  assert.match(persist, /const sanitized = sanitizeSnapshot\(snapshot\)/);
  assert.match(persist, /if \(!sanitized\) return "error"/);
  assert.match(persist, /store\.set\(WORKSPACE_SNAPSHOT_KEY, sanitized\)/);
  assert.doesNotMatch(persist, /sanitizeSnapshot\(snapshot\) \?\? snapshot/);
  assert.match(persist, /return "saved";[\s\S]*?catch \{[\s\S]*?return "error";/);
  assert.match(persist, /from "\.\/persist-snapshot\.ts"/);
  assert.match(persist, /export \{ sanitizeSnapshot \} from "\.\/persist-snapshot\.ts"/);
  assert.match(persistSnapshot, /export interface WorkspaceSnapshotV1/);
  assert.match(persistSnapshot, /function sanitizeRemoteInfo\(remote: unknown\): Session\["remote"\] \| undefined/);
  assert.match(persistSnapshot, /function isSafeRecordKey\(key: string\): boolean/);
  assert.match(persistSnapshot, /key !== "__proto__" && key !== "prototype" && key !== "constructor"/);
  assert.match(persistenceDoc, /rejects unsafe record keys such as `__proto__` \/ `prototype` \/ `constructor`/);
  assert.match(persistenceDoc, /normal `useInit` runtime save path[\s\S]*writes the workspace\s+snapshot directly/);
  assert.doesNotMatch(persistenceDoc, /legacy `sessions`[\s\S]*keys and keep them in sync with the snapshot/);
  assert.match(persistSnapshot, /from "\.\.\/modules\/ssh\/hosts-model\.ts"/);
  assert.match(persistSnapshot, /const port = parseSshPort\(r\.port\)/);
  assert.match(persistSnapshot, /remote === undefined \|\| Boolean\(sanitizeRemoteInfo\(remote\)\)/);
  assert.match(persistSnapshot, /isSafeRecordKey\(s\.id\)/);
  assert.doesNotMatch(persistSnapshot, /remote === null/);
  assert.doesNotMatch(persistSnapshot, /p\.remote = s\.remote/);
  assert.match(persistSnapshot, /function sanitizeTerminalSnapshot\(raw: unknown\): PersistedTerminalSnapshot \| null/);
  assert.match(terminalSnapshotLimits, /MAX_TERMINAL_SNAPSHOT_SERIALIZED_SIZE = 256 \* 1024/);
  assert.match(terminalSnapshotLimits, /MAX_TERMINAL_SNAPSHOTS = 8/);
  assert.match(persistSnapshot, /from "\.\.\/modules\/terminal\/lib\/terminal-snapshot-limits\.ts"/);
  assert.match(persistSnapshot, /Number\.isFinite\(raw\)/);
  assert.match(persistSnapshot, /trimTerminalSnapshotSerialized\(t\.serialized, MAX_TERMINAL_SNAPSHOT_SERIALIZED_SIZE\)/);
  assert.match(persistSnapshot, /sort\(\(a, b\) => b\[1\]\.capturedAt - a\[1\]\.capturedAt\)/);
  assert.match(persistSnapshot, /isSafeRecordKey\(k\) && typeof v === "number" && Number\.isFinite\(v\)/);
  assert.match(persistSnapshot, /if \(!isSafeRecordKey\(k\) \|\| !sessionIds\.has\(k\)\)/);
  assert.match(persistSnapshot, /if \(!isSafeRecordKey\(k\) \|\| !sessionIds\.has\(k\)\) continue/);
  assert.match(persistSnapshot, /export function sanitizeSnapshot/);
  assert.match(persistSnapshot, /collapsedDiffSections: Record<string, true>/);
  assert.match(persistSnapshot, /v === true && isSafeRecordKey\(k\)/);
  assert.match(persistSnapshot, /const collapsedDiffSections = sanitizeTrueRecord\(uiRaw\.collapsedDiffSections\)/);
  assert.match(init, /import \{ toPersistedSession \} from "@\/state\/persist-snapshot"/);
  assert.match(init, /sessions: st\.sessions\.map\(toPersistedSession\)/);
  assert.match(init, /collapsedDiffSections: ui\.collapsedDiffSections/);
  assert.match(init, /collapsedDiffSections: snapshot\.ui\.collapsedDiffSections/);
  assert.match(init, /s\.collapsedDiffSections/);
  assert.match(ui, /collapsedDiffSections: Record<string, true>/);
  assert.match(ui, /toggleDiffSectionCollapsed: \(section: string\) => void/);
  assert.match(recordKeys, /hasOwnProperty\.call\(record, key\)/);
  assert.match(recordKeys, /hasTrueRecordKey\(record, key\)/);
  assert.match(recordKeys, /getNumberRecordValue\(record: Record<string, number>, key: string, fallback = 0\)/);
  assert.match(recordKeys, /toggleTrueRecordKey\(record: Record<string, true>, key: string\)/);
  assert.match(ui, /toggleTrueRecordKey\(s\.collapsedDirs, dir\)/);
  assert.match(ui, /toggleTrueRecordKey\(s\.collapsedDiffSections, section\)/);
  assert.match(sidebar, /hasTrueRecordKey\(collapsedDirs, dir\)/);
  assert.match(sidebar, /getNumberRecordValue\(dirCloseConfirmations, dir\) > 0/);
  assert.match(sidebar, /confirmCloseAt=\{getNumberRecordValue\(closeConfirmations, s\.id\)\}/);
  assert.doesNotMatch(sidebar, /!!collapsedDirs\[dir\]/);
  assert.doesNotMatch(sidebar, /!!dirCloseConfirmations\[dir\]/);
  assert.doesNotMatch(sidebar, /!!closeConfirmations\[s\.id\]/);
  assert.match(diffPanel, /useUIStore\(\(s\) => s\.collapsedDiffSections\)/);
  assert.match(diffPanel, /getNumberRecordValue\(s\.gitNonce, session\.id\)/);
  assert.match(diffPanel, /hasTrueRecordKey\(collapsedSections, section\.key\)/);
  assert.match(diffPanel, /toggleDiffSectionCollapsed\(section\.key\)/);
  assert.match(overviewPanel, /const EMPTY_TIMELINE: readonly TimelineEvent\[\] = Object\.freeze\(\[\]\);/);
  assert.match(overviewPanel, /s\.sessionTimelines\[session\.id\] \?\? EMPTY_TIMELINE/);
  assert.doesNotMatch(overviewPanel, /s\.sessionTimelines\[session\.id\] \?\? \[\]/);
  assert.doesNotMatch(diffPanel, /!!collapsedSections\[section\.key\]/);
  assert.doesNotMatch(diffPanel, /s\.gitNonce\[session\.id\]/);
  assert.doesNotMatch(diffPanel, /localStorage/);
  assert.doesNotMatch(diffPanel, /sessionStorage/);
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

  assert.match(init, /const win = tryGetCurrentWindow\(\);/);
  assert.match(init, /win\.isFullscreen\(\)/);
  assert.match(init, /win\.onCloseRequested/);
  assert.doesNotMatch(init, /getCurrentWindow\(\)/);
});

test("window API lookups are guarded so metadata failures do not blank the app", () => {
  const helper = read("src/ui/lib/current-window.ts");
  const main = read("src/main.tsx");
  const sources = [
    read("src/app/useInit.ts"),
    read("src/app/useGlobalShortcut.ts"),
    read("src/ui/Titlebar.tsx"),
    read("src/ui/dock-badge.ts"),
    read("src/ui/terminal-attention.ts"),
  ];

  assert.match(helper, /export function tryGetCurrentWindow/);
  assert.match(helper, /try \{[\s\S]*return getCurrentWindow\(\);[\s\S]*\} catch \(error\) \{/);
  assert.match(main, /function renderBootError/);
  assert.match(main, /import\("\.\/app\/App"\)/);
  for (const source of sources) {
    assert.match(source, /tryGetCurrentWindow/);
    assert.doesNotMatch(source, /getCurrentWindow\(\)/);
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
  assert.match(bridge, /export interface GrepHit/);
  assert.match(bridge, /export function fsGrep/);
  assert.match(bridge, /export function fsCancelGrep/);
  assert.match(explorer, /fsSearch\(baseDir, q, searchLimit, includeHidden\)/);
  assert.match(explorer, /nextFileSearchLimit/);
  assert.match(explorer, /fsGrep\(q, baseDir, \{ requestId: localGrepRequestId!, caseInsensitive: false, maxResults: searchLimit \}\)/);
  assert.match(explorer, /fsCancelGrep\(localGrepRequestId\)/);
  assert.match(explorer, /groupGrepHitsByFile\(resp\.hits\)/);
  // Remote (SSH) name search runs `find` over the exec channel and content
  // search runs `grep` over it (ssh_fs_grep), so BOTH modes stay enabled for
  // remote sessions — the old disabled={isRemote} toggle must not come back.
  assert.match(explorer, /sshSearch\(remotePtyId, baseDir, q, searchLimit\)/);
  assert.match(explorer, /sshGrep\(remotePtyId, baseDir, q, searchLimit\)/);
  const fileSearchSession = read("src/ui/lib/file-search-session.ts");
  assert.match(fileSearchSession, /export class FileSearchGeneration/);
  assert.match(explorer, /FileSearchGeneration/);
  assert.match(explorer, /searchGen\.isCurrent\(token\)/);
  assert.match(explorer, /searchGen\.invalidate\(\)/);
  assert.doesNotMatch(explorer, /disabled=\{isRemote\}/);
  // Remote grep hits can't jump to a local editor; they toggle the inline
  // remote FilePreview instead.
  assert.match(explorer, /isRemote[\s\S]*?\? toggleSearchFile\(group\.path\)[\s\S]*?: openEditor\(group\.path, ln\.line\)/);
  // Editor launch failures must surface a toast (shared openInEditorWithToast helper),
  // not vanish into an empty catch.
  assert.match(explorer, /const openEditor = \(path: string, line\?: number\) =>[\s\S]*?openInEditorWithToast\(externalEditor, path/);
  assert.doesNotMatch(explorer, /openInEditor\([^)]*\)\.catch\(\(\) => \{\}\)/);
  assert.match(explorer, /placeholder=\{searchMode === "content" \? t\("explorer\.search_placeholder_content"\) : t\("explorer\.search_placeholder"\)\}/);
  assert.match(explorer, /const next = m === "name" \? "content" : "name"/);
  assert.match(explorer, /setReloadKey\(\(n\) => n \+ 1\)/);
  assert.match(explorer, /setIncludeHidden\(\(v\) => !v\)/);
  assert.match(explorer, /items: isRemote[\s\S]*?id: "dir:copy-path"/);
  assert.match(explorer, /items: isRemote[\s\S]*?id: "file:copy-path"/);
  const remoteFsBridge = read("src/modules/ssh/remote-fs-bridge.ts");
  assert.match(remoteFsBridge, /export function sshGrep\(/);
  assert.match(remoteFsBridge, /invoke<GrepResponse>\("ssh_fs_grep"/);
  // A directory Refresh must drop BOTH remote caches, or stale grep hits
  // outlive the reload the same way stale find hits used to.
  assert.match(
    remoteFsBridge,
    /searchCache\.invalidateSession\(ptyId\);[\s\S]*?grepCache\.invalidateSession\(ptyId\);/,
  );
  const remoteGit = read("src-tauri/src/modules/ssh/remote_git.rs");
  assert.match(remoteGit, /pub async fn ssh_fs_grep/);
  assert.match(remoteGit, /fn parse_grep_output\(raw: &str, root: &str, max_results: usize\)/);
  const tauriLib = read("src-tauri/src/lib.rs");
  assert.match(tauriLib, /modules::ssh::remote_git::ssh_fs_grep,/);
  const zhDictForExplorer = read("src/modules/i18n/locales/zh-CN.json");
  assert.match(zhDictForExplorer, /"explorer\.search_placeholder": "搜索当前项目"/);
  assert.match(zhDictForExplorer, /"explorer\.search_placeholder_content": "搜索文件内容"/);
  assert.match(zhDictForExplorer, /"explorer\.content_no_match": "未找到匹配内容"/);
  assert.match(search, /#\[serde\(rename_all = "camelCase"\)\]/);
  assert.match(search, /include_hidden: Option<bool>/);
  assert.match(search, /\.hidden\(!include_hidden\)/);
  // fs_search collects a larger candidate pool, ranks, THEN truncates to the
  // response cap — walking to exactly `cap` hits starved the filename-first
  // ranking of candidates on big trees.
  assert.match(search, /let scan_cap = \(cap \* 5\)\.min\(1000\);/);
  assert.match(search, /out\.len\(\) >= scan_cap/);
  assert.match(search, /out\.truncate\(cap\);/);
  assert.match(tree, /include_hidden: Option<bool>/);
});

test("pure SSH host mapping avoids importing the Tauri IPC bridge", () => {
  const bridge = read("src/modules/ssh/hosts-bridge.ts");
  const model = read("src/modules/ssh/hosts-model.ts");
  const sshConnect = read("src/ui/overlays/SshConnect.tsx");
  const sshLogicTest = read("tests/ssh-logic.test.mjs");

  assert.match(bridge, /from "\.\/hosts-model\.ts"/);
  assert.match(bridge, /normalizeSshPort/);
  assert.match(bridge, /parseSshPort/);
  assert.doesNotMatch(model, /@tauri-apps\/api/);
  assert.match(model, /export function parseSshPort/);
  assert.match(model, /Number\.isInteger\(value\)/);
  assert.doesNotMatch(model, /Math\.trunc\(value\)/);
  assert.match(model, /export function normalizeSshPort/);
  assert.match(sshConnect, /import \{[\s\S]*normalizeSshPort[\s\S]*parseSshPort[\s\S]*\} from "@\/modules\/ssh\/hosts-bridge"/);
  assert.match(sshConnect, /parseSshPort\(portText\) !== null/);
  assert.match(sshConnect, /normalizeSshPort\(port\)/);
  assert.match(sshLogicTest, /from "\.\.\/src\/modules\/ssh\/hosts-model\.ts"/);
  assert.match(sshLogicTest, /normalizeSshPort/);
  assert.match(sshLogicTest, /parseSshPort/);
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
  const bridge = read("src/modules/git/git-bridge.ts");
  const main = read("src/ui/MainArea.tsx");
  const diff = read("src/ui/DiffPanel.tsx");
  const watcher = read("src/modules/git/git-watcher.ts");
  const lifecycle = read("src/modules/terminal/lib/session-lifecycle.ts");
  const localTerminalCwd = read("src/modules/session/local-terminal-cwd.ts");

  assert.match(bridge, /gitDiff\(repoPath: string, file: string, stage: FileChange\["stage"\]\)/);
  assert.match(types, /export type GitState = "unknown" \| "repo" \| "notGit";/);
  assert.match(types, /gitState\?: GitState;/);
  assert.match(main, /activeIsRemote/);
  assert.match(main, /getNumberRecordValue\(s\.gitNonce, active\.id\)/);
  assert.match(main, /gitState: "repo"/);
  assert.match(main, /gitState: "notGit"/);
  assert.match(lifecycle, /gitState: "unknown"/);
  // Stable empty-array identity + frontend-composed localized summary. The
  // store/IPC carry no display string anymore (the backend used to bake
  // hardcoded Chinese locally and English remotely into StatusResult).
  assert.match(diff, /session\.changes\?\.files \?\? EMPTY_FILES/);
  assert.match(diff, /const EMPTY_FILES: readonly FileChange\[\] = Object\.freeze\(\[\]\);/);
  assert.match(diff, /function composeChangesSummary\(/);
  assert.match(diff, /summarizeChangedFiles\(files\)/);
  assert.match(diff, /useMemo\(\(\) => composeChangesSummary\(files, t\), \[files, t\]\)/);
  assert.doesNotMatch(diff, /session\.changes\?\.summary/);
  assert.doesNotMatch(bridge, /summary: string/);
  assert.match(diff, /session\.gitState === "notGit"/);
  assert.match(diff, /function fileRowKey\(file: Pick<FileChange, "stage" \| "path">\)/);
  assert.match(diff, /expandedFileKey/);
  assert.match(diff, /gitDiff\(requestedRepoPath, file\.path, file\.stage\)/);
  assert.match(diff, /diffGenerationRef/);
  assert.match(diff, /repoPathRef\.current === requestedRepoPath/);
  assert.match(diff, /setDiffErrors\(\(prev\) => \(\{ \.\.\.prev, \[key\]: e instanceof Error \? e\.message : String\(e\) \}\)\)/);
  assert.match(diff, /t\("diff\.mini\.retry"\)/);
  assert.match(diff, /useSessionsStore\.getState\(\)\.refreshGit\(session\.id\)/);
  assert.doesNotMatch(diff, /\bgitStatus\b/);
  assert.match(watcher, /const WATCH_FALLBACK_POLL_MS = 5_000/);
  assert.match(watcher, /function refreshSessionsForRepo\(repoPath: string\): void/);
  assert.match(watcher, /const backendOperations = createSerializedAsyncQueue\(\)/);
  assert.match(watcher, /function acquireBackendWatch\(repoPath: string\): Promise<void>/);
  assert.match(watcher, /function releaseBackendWatch\(repoPath: string\): Promise<void>/);
  assert.match(watcher, /backendOperations\.enqueue\(repoPath, \(\) => gitWatch\(repoPath\)\)/);
  assert.match(watcher, /acquireBackendWatch\(repoPath\)[\s\S]*?if \(activeRepos\.has\(repoPath\)\) \{[\s\S]*?stopFallbackPoller\(repoPath\)/);
  assert.doesNotMatch(watcher, /else \{[\s\S]*?releaseBackendWatch\(repoPath\)/);
  assert.match(watcher, /function startFallbackPoller\(repoPath: string\): void \{[\s\S]*?if \(!activeRepos\.has\(repoPath\)/);
  assert.match(watcher, /\.catch\(\(\) => \{[\s\S]*?startFallbackPoller\(repoPath\)/);
  assert.match(watcher, /activeRepos\.delete\(repoPath\);[\s\S]*?stopFallbackPoller\(repoPath\);[\s\S]*?void releaseBackendWatch\(repoPath\)\.catch/);
  assert.doesNotMatch(localTerminalCwd, /@\/ui\/types|ui\/types/);
});

test("session persistence is debounced and still flushed on close", () => {
  const init = read("src/app/useInit.ts");
  const persistenceDoc = read("docs/STATE_AND_PERSISTENCE.md");
  assert.match(init, /Promise\.all\(\[configReady, loadWorkspaceSnapshot\(\)\]\)/);
  assert.match(init, /let saveTimer: ReturnType<typeof setTimeout> \| null = null/);
  assert.match(init, /const scheduleSave = \(\) => \{/);
  assert.match(init, /setTimeout\(\(\) => \{[\s\S]*?persistNow\(\);[\s\S]*?\}, 500\)/);
  assert.match(init, /scheduleSave\(\);/);
  // 30s backstop flush is gated on the terminal-snapshot dirty flag, so an idle
  // or hidden app with no new output performs no redundant serialize + disk write.
  assert.match(init, /setInterval\(\(\) => \{[\s\S]*?if \(!consumeTerminalSnapshotDirty\(\)\) return;[\s\S]*?persistNow\(\)\.then\(\(result\) => \{[\s\S]*?if \(result !== "saved"\) markTerminalSnapshotDirty\(\);[\s\S]*?\}, 30_000\)/);
  assert.match(persistenceDoc, /consumeTerminalSnapshotDirty\(\)[\s\S]*?only flushes when terminal scrollback has[\s\S]*?changed since the last save/);
  assert.doesNotMatch(persistenceDoc, /setInterval\(persistNow, 30_000\) saves every 30 s/);
  assert.match(init, /onCloseRequested\(async \(event\) => \{[\s\S]*?event\.preventDefault\(\);[\s\S]*?clearTimeout\(saveTimer\);[\s\S]*?const result = await persistNow\(\);[\s\S]*?if \(result === "error"\) return;[\s\S]*?await win\.hide\(\)/);
});

test("terminal snapshot writes flip a dirty flag the persist backstop consumes", () => {
  const init = read("src/app/useInit.ts");
  const snap = read("src/modules/terminal/lib/terminal-snapshot.ts");
  const terminalSnapshotLimits = read("src/modules/terminal/lib/terminal-snapshot-limits.ts");
  const scheduler = read("src/modules/terminal/lib/terminal-snapshot-scheduler.ts");
  const terminalView = read("src/ui/TerminalView.tsx");
  const sessions = read("src/state/sessions.ts");
  // The dirty flag is the contract that lets the 30s backstop skip redundant
  // writes: output (update) and session removal must set it; restore (loading
  // from disk) must NOT, since that data was just persisted.
  assert.match(terminalSnapshotLimits, /MAX_TERMINAL_SNAPSHOT_SERIALIZED_SIZE = 256 \* 1024/);
  assert.match(terminalSnapshotLimits, /MAX_TERMINAL_SNAPSHOTS = 8/);
  assert.match(snap, /from "\.\/terminal-snapshot-limits\.ts"/);
  assert.match(scheduler, /from "\.\/terminal-snapshot\.ts"/);
  assert.match(snap, /export function consumeTerminalSnapshotDirty\(\): boolean \{/);
  assert.match(snap, /export function markTerminalSnapshotDirty\(\): void \{/);
  assert.match(snap, /export function updateTerminalSnapshot\([\s\S]*?dirty = true;/);
  assert.match(snap, /if \(snapshots\.delete\(sessionId\)\) dirty = true;/);
  assert.doesNotMatch(snap, /restoreTerminalSnapshots[\s\S]*?dirty = true/);
  assert.match(init, /import \{[\s\S]*markTerminalSnapshotDirty[\s\S]*\} from "@\/modules\/terminal\/lib\/terminal-snapshot"/);
  assert.match(init, /if \(!consumeTerminalSnapshotDirty\(\)\) return;[\s\S]*?persistNow\(\)\.then\(\(result\) => \{[\s\S]*?if \(result !== "saved"\) markTerminalSnapshotDirty\(\);/);
  assert.match(sessions, /removeTerminalSnapshot\(id\)/);
  assert.match(scheduler, /shouldCapture = \(\) => true/);
  assert.match(scheduler, /if \(!shouldCapture\(\)\) return;/);
  assert.match(scheduler, /const flush = \(\) => \{[\s\S]*?clearTimeout\(snapshotTimer\);[\s\S]*?capture\(\);[\s\S]*?\};/);
  assert.match(scheduler, /return \{[\s\S]*?schedule,[\s\S]*?flush,[\s\S]*?dispose\(\)/);
  assert.doesNotMatch(scheduler, /if \(shouldCapture\(\)\) capture\(\);/);
  assert.match(terminalView, /shouldCapture: \(\) =>[\s\S]*sessions\.some\(\(s\) => s\.id === sessionIdRef\.current\)/);
  assert.match(terminalView, /handleTerminalProcessExit\(term, sessionIdRef\.current, code, Boolean\(getCurrentSession\(\)\?\.remote\)\);[\s\S]*?snapshotScheduler\.flush\(\);/);
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
  assert.match(keys, /splitFocusTarget\(ui\.split, st\.activeSessionId, direction\)/);
  assert.match(keys, /if \(target\) st\.setActive\(target\)/);
  assert.match(main, /const repoPath = normalizeLocalRepoPath\(activeDir\);/);
  assert.match(main, /if \(!repoPath\) \{[\s\S]*?setRemote\(null\);[\s\S]*?gitState: "notGit"[\s\S]*?return;/);
  assert.match(main, /gitAheadBehind\(repoPath\)/);
  assert.match(main, /gitStatus\(repoPath\)/);
  // Remote (SSH) sessions route through the exec-channel git path, not the
  // local git2 path — guard that the remote branch exists and the local calls
  // never receive a raw dir.
  assert.match(main, /sshGitStatus\(activePtyId, activeDir \?\? ""\)/);
  assert.doesNotMatch(main, /gitAheadBehind\(active\.dir\)/);
  assert.doesNotMatch(main, /gitStatus\(active\.dir\)/);
  // The git effect depends on captured primitives, never the whole `active`
  // object: updateSession bumps updatedAt on every patch, and the effect
  // itself calls updateSession, so an object dependency would loop.
  assert.match(main, /\}, \[activeDir, activeId, activePtyId, activeIsRemote, nonce\]\);/);
  // The localized changes summary is composed in DiffPanel from `files`; the
  // store no longer carries a pre-baked display string.
  assert.match(main, /changes: \{ files: status\.files \}/);
  assert.doesNotMatch(main, /summary: status\.summary/);
  assert.match(settings, /maxWidth: "calc\(100vw - 32px\)"/);
});

test("remote file downloads are reachable from the explorer", () => {
  const explorer = read("src/ui/FileExplorer.tsx");
  const bridge = read("src/modules/ssh/remote-fs-bridge.ts");
  const capability = JSON.parse(read("src-tauri/capabilities/default.json"));

  assert.match(explorer, /saveDialog\(\{/);
  assert.match(explorer, /sshDownload\(remotePtyId, remotePath, localPath\)/);
  assert.match(explorer, /id: "file:download"/);
  assert.match(bridge, /invoke<number>\("ssh_fs_download"/);
  assert.ok(capability.permissions.includes("dialog:allow-save"));
});

test("session store keeps active sessions visible in split mode and cleans per-session metadata", () => {
  const source = read("src/state/sessions.ts");
  const sessionsGit = read("src/state/sessions-git.ts");
  const init = read("src/app/useInit.ts");

  assert.match(source, /function ensureSessionVisibleInSplit\(sessionId: string\)/);
  assert.match(source, /ui\.setSplitPaneB\(sessionId\)/);
  assert.match(source, /ensureSessionVisibleInSplit\(s\.id\)/);
  assert.match(source, /if \(accepted\) ensureSessionVisibleInSplit\(id\);/);
  assert.match(source, /const \{ \[id\]: _gitNonce, \.\.\.gitNonce \} = state\.gitNonce;/);
  assert.match(source, /scheduleGitRefresh\(id, set\)/);
  assert.match(source, /from "\.\/sessions-git"/);
  // refreshGit coalesces per-session nonce bumps into one store write via
  // bumpGitNonce → flushGitNonceBumps; the increment itself is unchanged.
  assert.match(sessionsGit, /gitNonce\[id\] = getNumberRecordValue\(gitNonce, id\) \+ 1/);
  assert.match(sessionsGit, /function bumpGitNonce\(id: string,/);
  assert.match(sessionsGit, /queueMicrotask\(\(\) => flushGitNonceBumps\(set\)\)/);
  assert.match(source, /getNumberRecordValue\(get\(\)\.closeConfirmations, s\.id\)/);
  assert.match(source, /getNumberRecordValue\(get\(\)\.dirCloseConfirmations, dir\)/);
  assert.match(source, /getNumberRecordValue\(get\(\)\.closeConfirmations, id\)/);
  assert.match(source, /sessions\[Math\.min\(Math\.max\(removedIndex, 0\), sessions\.length - 1\)\]/);
  assert.match(init, /const merged = current\.sessions\.length === 0/);
  assert.match(init, /sidebarVisible: snapshot\.ui\.sidebarVisible/);
  assert.match(init, /panelVisible: snapshot\.ui\.panelVisible/);
  assert.match(init, /const agentResume: WorkspaceSnapshotV1\["agentResume"\] = \{\}/);
  assert.match(init, /if \(s\.agentResume\) agentResume\[s\.id\] = s\.agentResume/);
  assert.match(init, /sessions: st\.sessions\.map\(toPersistedSession\)/);
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
  assert.match(preview, /result\.truncated \? `\\n\$\{t\("preview\.truncated"\)\}` : ""/);
  assert.match(git, /out\.len\(\) \+ content\.len\(\) \+ prefix_len > DIFF_MAX_BYTES/);
  assert.match(git, /commit` 模块只在 `cfg\(test\)` 下保留旧写路径的 pathspec 回归 fixture/);
  assert.match(gitBridge, /git\/mod\.rs 的只读 IPC 契约/);
  assert.doesNotMatch(gitBridge, /git\/mod\.rs \+ git\/commit\.rs 的命令契约/);
});

test("shell tint boot and contrast helpers are wired for cold-start and AA checks", () => {
  const boot = read("src/styles/shell-tint-boot.ts");
  const contrast = read("src/styles/shell-tint-contrast.ts");
  const html = read("index.html");
  const vite = read("vite.config.ts");

  assert.equal(existsSync(resolve(root, "tests/shell-tint-contrast.test.mjs")), true);
  assert.match(boot, /export const BOOT_APPEARANCE_STORAGE_KEY = "tunara\.boot\.appearance"/);
  assert.match(boot, /export function applyBootShellTint/);
  assert.match(boot, /export function persistBootAppearance/);
  assert.match(boot, /export function renderBootInlineScript/);
  assert.match(contrast, /export function contrastRatio/);
  assert.match(contrast, /export function assertShellTintContrast/);
  assert.match(html, /\/\*__SHELL_TINT_BOOT__\*\//);
  assert.match(vite, /base:\s*"\.\/"/);
  assert.match(vite, /shellTintBootPlugin/);
  assert.match(vite, /renderBootInlineScript/);
});

test("appearance settings are sanitized and command palette exposes useful actions", () => {
  const ui = read("src/state/ui.ts");
  const palette = read("src/ui/overlays/CommandPalette.tsx");
  const paletteFilter = read("src/ui/overlays/command-palette-filter.ts");
  const sidebar = read("src/ui/Sidebar.tsx");
  const toast = read("src/ui/Toast.tsx");
  const css = read("src/styles/globals.css");
  const zhDict = read("src/modules/i18n/locales/zh-CN.json");
  const terminalTheme = read("src/styles/terminalTheme.ts");
  const useTheme = read("src/app/useTheme.ts");

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
  assert.match(paletteFilter, /function scopeForAlias\(alias: string\): CommandPaletteScope \| undefined/);
  assert.match(paletteFilter, /hasOwnProperty\.call\(SCOPE_ALIASES, alias\)/);
  assert.doesNotMatch(paletteFilter, /const scope = SCOPE_ALIASES\[prefixMatch\[1\]\.toLowerCase\(\)\]/);
  assert.match(paletteFilter, /labelMatchIndex/);
  assert.match(paletteFilter, /getNumberRecordValue\(usage, a\.id\)/);
  assert.match(terminalTheme, /function getOwnTheme<T>\(themes: Record<string, T>, name: string\): T \| undefined/);
  assert.match(terminalTheme, /hasOwnProperty\.call\(themes, name\)/);
  assert.match(terminalTheme, /export function getShellTint\(terminalTheme: string\): Record<string, string> \| undefined/);
  assert.match(terminalTheme, /return getOwnTheme\(SHELL_TINTS, terminalTheme\)/);
  assert.match(terminalTheme, /getOwnTheme\(NAMED_DARK_THEMES, terminalTheme\) !== undefined/);
  assert.match(terminalTheme, /const darkTheme = terminalTheme !== "default" \? getOwnTheme\(NAMED_DARK_THEMES, terminalTheme\) : undefined/);
  assert.doesNotMatch(terminalTheme, /!!NAMED_DARK_THEMES\[terminalTheme\]/);
  assert.match(useTheme, /import \{ applyBootShellTint \} from "@\/styles\/shell-tint-boot"/);
  assert.match(useTheme, /applyBootShellTint\(root, terminalTheme, theme, accent/);
  assert.doesNotMatch(useTheme, /SHELL_TINTS\[terminalTheme\]/);
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

  assert.match(html, /\/\*__SHELL_TINT_BOOT__\*\//);
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
  assert.match(terminalLineCwd, /if \(!cwd\.trim\(\)\)/);
  assert.match(terminalLineCwd, /last\?\.cwd === cwd/);
  assert.match(terminalFileLinks, /openInEditorWithToast\(options\.getEditor\(\), path, \{ line: match\.line, column: match\.column \}\)/);
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
  assert.match(status, /minHeight: "var\(--h-inline-bar\)"/);
  assert.match(status, /borderBottom: "1px solid var\(--c-border-1\)"/);

  assert.doesNotMatch(sessions, /launchAllAgents/);
  assert.doesNotMatch(sidebar, /启动所有 Agent/);
  assert.doesNotMatch(explorer, /启动所有 Agent/);
  assert.match(contributing, /批量启动入口/);

  assert.match(contextMenu, /role="menu"/);
  assert.match(contextMenu, /ArrowDown/);
  assert.match(contextMenu, /role="separator"/);
  assert.match(contextMenu, /boxShadow: "var\(--shadow-menu\)"/);
  assert.match(contextMenu, /export type MenuIconName = "terminal" \| "editor" \| "copy" \| "download" \| "rename" \| "search" \| "close"/);
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
  assert.match(settings, /tauriConfirmDialog\(t\("settings\.appearance\.reset_confirm"\)/);
  assert.match(settings, /useUIStore\.getState\(\)\.resetAppearance\(\)/);
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
  const sidebarDirMenu = read("src/ui/sidebar-dir-group-menu.ts");
  const palette = read("src/ui/overlays/CommandPalette.tsx");
  const resolver = read("src-tauri/src/modules/resolver/mod.rs");
  const toast = read("src/ui/Toast.tsx");

  assert.match(registry, /import agentRegistryData from "\.\/registry-data\.json" with \{ type: "json" \}/);
  assert.match(registry, /export const AGENT_REGISTRY/);
  assert.match(registry, /export const AGENT_COMMANDS/);
  assert.match(registry, /export const AGENT_NAMES/);
  assert.match(registry, /function makeRecord<T>\(entries: Iterable<readonly \[string, T\]>\): Record<string, T>/);
  assert.match(registry, /Object\.create\(null\)/);
  assert.match(registry, /function getOwnRecordValue<T>\(record: Record<string, T>, key: string\): T \| undefined/);
  assert.match(registry, /export function agentCodeForCommand\(command: string\): AgentCode \| null/);
  assert.match(lifecycle, /agentCodeForCommand/);
  assert.doesNotMatch(lifecycle, /return AGENT_COMMANDS\[cmd\] \?\? null/);
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

  assert.match(sessions, /closeSessions: \(ids: string\[\], opts\?: \{ toastSubtitle\?: string \}\) => boolean/);
  assert.match(sessions, /const closeConfirmationTimers = new Map/);
  assert.match(sessions, /function scheduleCloseConfirmationExpiry/);
  assert.match(sessions, /function scheduleDirCloseConfirmationExpiry/);
  assert.match(sessions, /const orderedTargets = get\(\)\.sessions\.filter/);
  assert.match(sessions, /unconfirmedBusy\.length > 0/);
  assert.match(sessions, /get\(\)\.closeSessions\(sessionIds, \{ toastSubtitle: t\("session\.close\.all_running_hint"\) \}\)/);
  assert.match(sessionCard, /e\.key === "F2"/);
  assert.match(sessionCard, /active && e\.key === "Enter"/);
  assert.match(sessionCard, /useDestructiveConfirmCountdown/);
  assert.match(sidebar, /confirmCloseAt=\{getNumberRecordValue\(closeConfirmations, s\.id\)\}/);
  assert.doesNotMatch(sidebar, /confirmClose=\{getNumberRecordValue\(closeConfirmations, s\.id\) > 0\}/);
  assert.doesNotMatch(sessionCard, /onClearCloseConfirm/);
  assert.doesNotMatch(sessionCard, /session\.changes\?\.files\.reduce/);
  assert.doesNotMatch(sidebar, /onClearCloseConfirm/);
  assert.doesNotMatch(sidebar, /clearDirCloseConfirmation/);
  const zhDict = read("src/modules/i18n/locales/zh-CN.json");
  assert.match(sidebarMenu, /label: t\("sidebar\.session\.rename"\), icon: "rename"/);
  assert.match(sidebarMenu, /label: t\("sidebar\.session\.close"\), icon: "close"/);
  assert.match(sidebarDirMenu, /dirGroupHasLocalFilesystem/);
  assert.match(sidebarDirMenu, /canUseSessionDirForLocalTerminal/);
  assert.match(sidebarDirMenu, /label: t\("sidebar\.dir\.close_all"\), icon: "close"/);
  assert.match(zhDict, /"sidebar\.session\.rename": "重命名"/);
  assert.match(zhDict, /"sidebar\.session\.close": "关闭会话"/);
  assert.match(zhDict, /"sidebar\.dir\.close_all": "关闭全部会话"/);
  assert.match(palette, /st\.closeSessions\(st\.sessions\.map/);
  assert.match(palette, /toastSubtitle: t\("palette\.toast\.running_need_confirm"\)/);
  assert.match(sessions, /destructive\.confirm_again\.close/);
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
  const sidebarNewTerminal = read("src/ui/SidebarNewTerminalControl.tsx");
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
  assert.match(titlebar, /const MAC_TITLEBAR_CONTROL_Y_OFFSET = -1/);
  assert.match(titlebar, /const titlebarControlTransform = _isMac \? `translateY\(\$\{MAC_TITLEBAR_CONTROL_Y_OFFSET\}px\)` : undefined/);
  assert.equal(titlebar.match(/transform: titlebarControlTransform/g)?.length, 3);
  assert.match(titlebar, /paddingLeft: 8/);
  assert.match(tokens, /--h-titlebar: 36px/);
  assert.match(sidebarNewTerminal, /padding: "8px 12px 6px"/);
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
  assert.match(main, /title=\{`\$\{t\("split\.horizontal"\)\} \$\{formatShortcut\(splitHorizontalShortcut\)\}`\}/);
  assert.match(main, /title=\{`\$\{t\("split\.vertical"\)\} \$\{formatShortcut\(splitVerticalShortcut\)\}`\}/);
  assert.match(main, /aria-label=\{t\("split\.horizontal"\)\}/);
  assert.doesNotMatch(main, /左右分栏|上下分栏|关闭分栏/);
  // Idle→fade delay (was 1500ms transition; now 1200ms delay before sliding out via keyframe)
  assert.match(status, /setFading\(true\), 1200\)/);
  // Exit animation now uses a keyframe ('statusBarSlideOut') driven by onAnimationEnd instead of an opacity/transform transition
  assert.match(status, /statusBarSlideOut var\(--duration-fast\)/);
  assert.match(status, /onAnimationEnd=\{/);
  assert.match(settings, /gridTemplateColumns: "repeat\(auto-fit, minmax\(118px, 1fr\)\)"/);
  assert.match(settings, /getShellTint/);
  assert.match(settings, /terminalThemePreviewColors/);
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
  // Search input is IME-safe: composition events gate the search query update
  // so CJK typing doesn't flicker. DiffFileRow now receives a stable
  // onSearchQueryChange prop instead of calling setSearchQuery directly.
  assert.match(diff, /isComposingRef = useRef\(false\)/);
  assert.match(diff, /onCompositionStart=\{\(\) => \{ isComposingRef\.current = true; \}\}/);
  assert.match(diff, /onCompositionEnd=\{/);
  assert.match(diff, /if \(isComposingRef\.current\) return;\s*onSearchQueryChange\(e\.target\.value\)/);
  assert.match(diff, /if \(e\.nativeEvent\.isComposing\) return;/);
  // DiffFileRow is defined outside DiffPanel so React reconciles rows by
  // identity instead of remounting every row on each state change.
  assert.match(diff, /function DiffFileRow\(/);
  assert.match(diff, /loadFileDiffStable/);
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
  assert.match(tokens, /--font-ui: 'JetBrains Mono', 'SFMono-Regular', 'PingFang SC', 'Noto Sans SC', monospace;/);
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
  assert.match(terminal, /import \{ createInputQueueFullWarner, emitTerminalNotification, reportTerminalInitializationFailure, requestInformationalAttention, safeDispose \} from "\.\/terminal-attention"/);
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
  assert.match(terminalDeviceAttributes, /sendInput: options\.sendInput/);
  assert.doesNotMatch(terminalDeviceAttributes, /term\.input\(/);
  assert.match(terminal, /let inputToPtyEnabled = true/);
  assert.match(terminal, /inputToPtyEnabled = false/);
  assert.match(terminal, /sendInput: writePty/);
  const sshConnection = read("src-tauri/src/modules/ssh/connection.rs");
  assert.match(sshConnection, /let mut accepting_input = true/);
  assert.match(sshConnection, /accepting_input = false/);
  assert.match(sshConnection, /input = input_rx\.recv\(\), if accepting_input/);
  assert.match(terminalAttention, /import \{ UserAttentionType \} from "@tauri-apps\/api\/window"/);
  assert.match(terminalAttention, /tryGetCurrentWindow\(\)[\s\S]*?requestUserAttention\(UserAttentionType\.Informational\)/);
  assert.doesNotMatch(terminalAttention, /getCurrentWindow\(\)/);
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
  assert.match(terminal, /import \{ scanTerminalInputBuffer, shouldScanTerminalInput \} from "@\/modules\/terminal\/lib\/terminal-input-buffer"/);
  assert.match(terminal, /import \{ useTerminalWebgl, type TerminalWebglRenderer \} from "\.\/useTerminalWebgl"/);
  assert.match(terminal, /createTerminalInstance\(\{/);
  assert.match(terminal, /linkHandler: createTerminalHyperlinkHandler\(openUrl\)/);
  // Paste protection must be wired with the Tauri dialog confirmer —
  // window.confirm never renders in wry's WKWebView (silent false), which
  // silently dropped every multiline/large paste before the fix.
  assert.match(terminal, /registerTerminalPasteProtection\(term, \(message\) =>\s*tauriConfirmDialog\(message, \{ kind: "warning" \}\)/);
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
  assert.match(terminalQuickSelectHook, /t\("quick_select\.empty\.body"\)/);
  assert.match(terminalQuickSelectHook, /window\.addEventListener\(TERMINAL_QUICK_SELECT_EVENT/);
  assert.match(terminalQuickSelectHook, /copyText\(item\.copyText\)/);
  assert.match(terminalQuickSelectHook, /if \(item\.kind === "text"\) \{[\s\S]*copyItem\(item\);[\s\S]*return;/);
  assert.match(terminalQuickSelectHook, /openInEditor\(useUIStore\.getState\(\)\.externalEditor, item\.target, item\.line, item\.column\)/);
  assert.match(terminalQuickSelectOverlay, /export function TerminalQuickSelect/);
  assert.match(terminalQuickSelectOverlay, /item\.kind !== "text"/);
  assert.match(terminalQuickSelectOverlay, /quickSelectHint\(index\)/);
  assert.match(terminalQuickSelectOverlay, /onCopy\(hintedItems\[exact\]\.item\)/);
  // Arrow keys step within the typed-hint subset and must not reset the prefix.
  assert.match(terminalQuickSelectOverlay, /function stepSelection\(direction: 1 \| -1\)/);
  assert.match(terminalQuickSelectOverlay, /hint\.startsWith\(typedHint\)/);
  assert.doesNotMatch(terminalQuickSelectOverlay, /ArrowDown[\s\S]*setTypedHint\(""\)/);
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
  assert.match(terminalSearchHook, /setSearchCount\(\{ current: 0, total: 0 \}\)/);
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
  assert.match(terminalBlocks, /import \{ hasTrueRecordKey, toggleTrueRecordKey \} from "@\/state\/record-keys"/);
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
  assert.match(terminalBlocks, /return copyText\(output\)/);
  assert.match(terminalBlocks, /resolveTerminalBlockRows/);
  assert.match(terminalBlocks, /term\.registerMarker/);
  assert.match(terminalBlocks, /block\.endMarker !== block\.startMarker/);
  assert.match(terminalBlocksPure, /export function resolveTerminalBlockRows/);
  assert.match(terminalBlocks, /const copyBlockCommand = useCallback\(async \(id: string\): Promise<boolean> =>/);
  assert.match(terminalBlocks, /const copyBlockCommandAndOutput = useCallback\(async \(id: string\): Promise<boolean> =>/);
  assert.match(terminalBlocks, /const readBlockOutput = useCallback\(\(id: string\): string \| null =>/);
  assert.match(terminalBlocks, /return readBlockOutputText\(term, block\)/);
  assert.match(terminalBlocks, /formatTerminalBlockCommandAndOutput\(block\.command, output\)/);
  assert.match(terminalBlocks, /return copyText\(block\.command\)/);
  assert.match(terminalBlocks, /term\.onScroll/);
  assert.match(terminalBlocks, /matchesKeybinding\(e, bindings\.navigatePrevBlock, isMac\)[\s\S]*navigateBlock\("previous"\)/);
  assert.match(terminalBlocks, /matchesKeybinding\(e, bindings\.navigateNextBlock, isMac\)[\s\S]*navigateBlock\("next"\)/);
  assert.match(terminalBlocks, /hasTrueRecordKey\(current, id\)/);
  assert.match(terminalBlocks, /toggleTrueRecordKey\(current, id\)/);
  assert.doesNotMatch(terminalBlocks, /current\[id\]/);
  assert.doesNotMatch(terminalBlocks, /\.\.\.current, \[id\]: true/);
  // Clipboard writes route through the shared copyText helper, not raw navigator.clipboard.
  assert.match(terminalBlocks, /import \{ copyText \} from "\.\/lib\/clipboard"/);
  assert.doesNotMatch(terminalBlocks, /navigator\.clipboard\.writeText/);
  assert.match(terminalBlocksBar, /export function TerminalBlocksBar/);
  assert.match(terminalBlocksBar, /type CopyBlockResult = boolean \| Promise<boolean>/);
  assert.match(terminalBlocksBar, /import \{ ContextMenu \} from "\.\/ContextMenu"/);
  assert.match(terminalBlocksBar, /import \{ buildBlockContextMenuItems \} from "@\/modules\/terminal\/lib\/terminal-blocks-menu"/);
  assert.match(terminalBlocksBar, /import \{ hasTrueRecordKey \} from "@\/state\/record-keys"/);
  assert.match(terminalBlocksBar, /className="cmd-chip"/);
  assert.match(terminalBlocksBar, /className="cmd-chip-more"/);
  assert.match(terminalBlocksBar, /buildBlockContextMenuItems\(contextMenu\.block, contextMenu\.completed, contextMenu\.collapsed/);
  assert.match(terminalBlocksBar, /onFilterBlock: \(block: TerminalCommandBlock\) => void/);
  assert.match(terminalBlocksBar, /const openContextMenu = \([\s\S]*setContextMenu/);
  assert.match(terminalBlocksBar, /onContextMenu=\{\(e\) => \{[\s\S]*openContextMenu\(stickyBlock/);
  assert.match(terminalBlocksBar, /openContextMenu\(block, completed, collapsed/);
  assert.match(terminalBlocksBar, /hasTrueRecordKey\(collapsedBlockIds, stickyBlock\.id\)/);
  assert.match(terminalBlocksBar, /hasTrueRecordKey\(collapsedBlockIds, block\.id\)/);
  assert.doesNotMatch(terminalBlocksBar, /!!collapsedBlockIds\[/);
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
  assert.doesNotMatch(terminalCodexState, /CODEX_DATA_BURST_BUSY_THRESHOLD|dataBurstCount/);
  assert.match(terminalCodexState, /CODEX_STATE_CHECK_DELAY_MS/);
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
  // that fixed the double-submit bug; 520→526 for the WebGL atlas-rebuild
  // wiring that fixed idle-garble; 526→540 for the manual-ssh detection wiring
  // (the parsing lives in ssh-command-detect.ts; the detect+suggest call is
  // wired on BOTH command-detection paths — the OSC 133 path that local
  // sessions use by default, and the keystroke fallback). 540→550 for the
  // post-exit inputToPtyEnabled gate + deferred DA handler registration.
  // The heavy logic always stays in its own module — this remains a guard
  // against re-monolithizing.
  assert.ok(terminal.split("\n").length < 550);
  assert.ok(sidebar.split("\n").length < 400);
});
