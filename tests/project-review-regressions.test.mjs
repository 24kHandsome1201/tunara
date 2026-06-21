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
