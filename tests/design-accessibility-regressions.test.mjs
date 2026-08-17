import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// The settings overlay is split across a shell and per-tab modules; scan them
// together so source assertions keep covering the whole settings surface.
const readSettingsSources = () => [
  "src/ui/overlays/Settings.tsx",
  "src/ui/overlays/settings/AppearanceSettings.tsx",
  "src/ui/overlays/settings/TerminalSettings.tsx",
  "src/ui/overlays/settings/AccessibilitySettings.tsx",
  "src/ui/overlays/settings/ShortcutsSettings.tsx",
  "src/ui/overlays/settings/CliSettings.tsx",
  "src/ui/overlays/settings/AppSettings.tsx",
  "src/ui/overlays/settings/WorkflowsSettings.tsx",
  "src/ui/overlays/settings/useCliStatus.ts",
  "src/ui/overlays/settings/controls.tsx",
].map(read).join("\n");

test("waiting confirmation uses a dedicated readable text token", () => {
  const tokens = read("src/styles/tokens.css");
  const card = read("src/ui/SessionCard.tsx");
  const global = read("src/ui/GlobalAgentBar.tsx");
  assert.match(tokens, /--c-warning-text:\s*oklch\(43%/);
  assert.match(tokens, /--c-warning-bg:/);
  assert.match(card, /data-confirm=\{confirmClose \? "true" : undefined\}/);
  assert.match(global, /var\(--c-warning-text\)/);
});

test("settings shortcuts and terminal interaction controls define every visual state", () => {
  const settings = readSettingsSources();
  const styles = read("src/styles/globals.css");
  const palettes = read("src/styles/terminalTheme.ts");

  assert.match(settings, /className="settings-terminal-interactions"/);
  assert.match(settings, /className="settings-control"/);
  assert.match(settings, /className="settings-shortcut-input"/);
  assert.match(settings, /className="settings-action-button"/);
  assert.match(settings, /<kbd className="settings-key-hint"/);
  assert.match(styles, /\.settings-action-button:hover:not\(:disabled\)/);
  assert.match(styles, /\.settings-action-button:active:not\(:disabled\)/);
  assert.match(styles, /\.settings-action-button:focus-visible/);
  assert.match(styles, /\.settings-action-button:disabled/);
  assert.match(styles, /\.dark \.settings-control \{ color-scheme: dark; \}/);
  assert.match(styles, /border: 1px solid var\(--c-control-border\)/);
  assert.equal((palettes.match(/"--c-control-border"/g) ?? []).length, 6);
});

test("non-settings native controls opt into the shared theme contract", () => {
  const styles = read("src/styles/globals.css");
  const allowedClasses = new Set(["ui-control", "ui-choice", "ui-progress", "ui-native-control"]);
  const roots = [new URL("../src", import.meta.url)];
  const files = [];

  while (roots.length > 0) {
    const directory = roots.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const path = new URL(entry.name, `${directory.href}/`);
      if (entry.isDirectory()) roots.push(path);
      else if (entry.name.endsWith(".tsx")
        && entry.name !== "Settings.tsx"
        && !path.pathname.includes("/src/ui/overlays/settings/")) files.push(path);
    }
  }

  const missing = [];
  for (const file of files) {
    const sourceText = fs.readFileSync(file, "utf8");
    const source = ts.createSourceFile(file.pathname, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName.getText(source);
        if (["input", "select", "textarea", "progress"].includes(tag)) {
          const className = node.attributes.properties.find((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === "className");
          const classes = className?.initializer && ts.isStringLiteral(className.initializer)
            ? className.initializer.text.split(/\s+/)
            : [];
          if (!classes.some((name) => allowedClasses.has(name))) {
            const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
            missing.push(`${file.pathname}:${line + 1}:${tag}`);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  assert.deepEqual(missing, []);
  assert.match(styles, /html \{ color-scheme: light; \}[\s\S]*html\.dark \{ color-scheme: dark; \}/);
  assert.match(styles, /\.sr-only \{/);
  assert.match(styles, /\.ui-button:hover:not\(:disabled\)/);
  assert.match(styles, /\.ui-button:active:not\(:disabled\)/);
  assert.match(styles, /\.ui-button:focus-visible/);
  assert.match(styles, /\.ui-button:disabled/);
  assert.match(styles, /\.ui-choice:checked/);
  assert.match(styles, /\.dark \.ui-native-control \{ color-scheme: dark; \}/);
  assert.doesNotMatch(files.map((file) => fs.readFileSync(file, "utf8")).join("\n"), /var\(--c-danger/);
});

test("folder-based terminal creation stays visible in empty and compact shells", () => {
  const app = read("src/app/App.tsx");
  const empty = read("src/ui/WorkspaceEmptyState.tsx");
  const titlebar = read("src/ui/Titlebar.tsx");
  assert.match(app, /WorkspaceEmptyState/);
  assert.match(empty, /onClick=\{onNewTerminalInDirectory\}[\s\S]*sidebar\.new_terminal_in_directory/);
  assert.match(empty, /className="hover-primary"[\s\S]*sidebar\.new_terminal_in_directory/);
  assert.match(titlebar, /onClick=\{onNewTerminalInDirectory\}[\s\S]*titlebar\.new_terminal_in_directory/);
});

test("session and activity rows do not nest action buttons inside button roles", () => {
  const card = read("src/ui/SessionCard.tsx");
  const global = read("src/ui/GlobalAgentBar.tsx");
  assert.match(card, /data-session-card-id=[\s\S]*className="session-card-select"/);
  assert.doesNotMatch(card, /role="button"/);
  assert.match(global, /role="group"[\s\S]*className="gbar-row-select"/);
  assert.doesNotMatch(card, /role="listitem"/);
  assert.doesNotMatch(global, /role="button"/);
});

test("paper chrome keeps one quiet voice: hierarchy, no squashy lists, muted glyphs", () => {
  const tokens = read("src/styles/tokens.css");
  const styles = read("src/styles/globals.css");
  const explorer = read("src/ui/FileExplorer.tsx");
  const explorerChrome = read("src/ui/file-explorer/chrome.tsx");
  const inspector = read("src/ui/InspectorPanel.tsx");
  const preview = read("src/ui/PreviewPanel.tsx");
  const shared = read("src/ui/shared.tsx");

  assert.doesNotMatch(tokens, /\.session-card:active \{ transform:/);
  assert.doesNotMatch(tokens, /\.gbar-row:active \{ transform:/);
  assert.doesNotMatch(tokens, /\.inspector-tab:active \{ transform:/);
  assert.doesNotMatch(tokens, /\.inspector-tab\[data-active="true"\] \{ background:/);
  assert.doesNotMatch(inspector, /background: "var\(--c-bg-2\)"/);
  assert.match(inspector, /background: "var\(--c-bg-1\)"/);
  assert.match(styles, /\.ui-button--ghost \{/);
  assert.match(styles, /\.ui-button--ghost:hover:not\(:disabled\)/);
  assert.match(styles, /\.ui-button--ghost:active:not\(:disabled\)/);
  assert.match(styles, /\.ui-button--ghost:disabled/);
  assert.match(styles, /\.preview-source-card \.preview-action-primary/);
  assert.match(preview, /className="preview-action-primary"/);
  assert.match(styles, /\.preview-disclosure > summary::before \{[\s\S]*border-right:/);
  assert.doesNotMatch(styles, /content: "› "/);
  const explorerIcons = read("src/ui/file-explorer/icons.tsx");
  assert.doesNotMatch(explorer, /stroke="var\(--c-accent\)"/);
  assert.doesNotMatch(explorerChrome, /stroke="var\(--c-accent\)"/);
  assert.doesNotMatch(explorerIcons, /stroke="var\(--c-accent\)"/);
  assert.match(explorerChrome, /<UploadIcon/);
  assert.match(explorerChrome, /<UploadFolderIcon/);
  assert.match(explorerChrome, /<DownloadIcon/);
  assert.match(explorerIcons, /className="explorer-tree-chevron"/);
  assert.match(shared, /export function UploadIcon/);
  assert.match(shared, /export function UploadFolderIcon/);
  assert.match(shared, /export function DownloadIcon/);
});
