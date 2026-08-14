import { useCallback, useEffect, useState } from "react";
import { useUIStore } from "@/state/ui";
import { useT } from "@/modules/i18n";
import {
  analyzeTerminalKeybindingRisk,
  analyzeTerminalScopedKeybindingRisk,
  captureKeybinding,
  defaultKeybindingsForPlatform,
  findKeybindingConflict,
  isFixedTerminalMenuKeybinding,
  isTerminalKeybindingAction,
  KEYBINDING_ACTIONS,
  TERMINAL_KEYBINDING_ACTIONS,
  type KeybindingAction,
} from "@/modules/config/keybindings";
import { IS_MAC, SECTION_LABEL, SECTION_HINT } from "./controls";

type BindingScope = "terminal" | "app";

function currentKeybindingPlatform(): "macos" | "windows" | "linux" {
  if (IS_MAC) return "macos";
  return navigator.platform.toLowerCase().includes("win") ? "windows" : "linux";
}

/** Shared state machine for both keybinding lists: at most one pending risky
 * binding and one warning message (tagged with the section it belongs to). */
function useKeybindingEditor() {
  const keybindings = useUIStore((s) => s.keybindings);
  const setKeybinding = useUIStore((s) => s.setKeybinding);
  const t = useT();
  const [pendingRisk, setPendingRisk] = useState<{ action: KeybindingAction; binding: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [messageScope, setMessageScope] = useState<BindingScope | null>(null);

  const clear = useCallback(() => {
    setPendingRisk(null);
    setMessage(null);
    setMessageScope(null);
  }, []);

  const warn = (scope: BindingScope, text: string) => {
    setMessageScope(scope);
    setMessage(text);
  };

  const capture = (scope: BindingScope, action: KeybindingAction, event: React.KeyboardEvent) => {
    event.preventDefault();
    event.stopPropagation();
    const binding = captureKeybinding(event.nativeEvent);
    if (!binding) return;
    if (isFixedTerminalMenuKeybinding(binding)) { warn(scope, t("settings.keybindings.fixed_menu_conflict")); return; }
    const conflict = findKeybindingConflict(keybindings, action, binding);
    if (conflict) { warn(scope, t("settings.keybindings.conflict", { action: t(`settings.keybindings.action.${conflict}`) })); return; }
    const analyze = scope === "terminal" ? analyzeTerminalScopedKeybindingRisk : analyzeTerminalKeybindingRisk;
    if (analyze(binding).risky) { setPendingRisk({ action, binding }); warn(scope, t("settings.keybindings.risk")); return; }
    setKeybinding(action, binding);
    clear();
  };

  const assign = (action: KeybindingAction, binding: string) => {
    setKeybinding(action, binding);
    clear();
  };

  const resetOne = (action: KeybindingAction) => assign(action, defaultKeybindingsForPlatform(currentKeybindingPlatform())[action]);

  return { keybindings, pendingRisk, message, messageScope, clear, capture, assign, resetOne };
}

type KeybindingEditor = ReturnType<typeof useKeybindingEditor>;

/** One binding row: readonly capture input plus reset (and optional disable)
 * actions; shows the pending-risk override button when this row triggered it. */
function KeybindingRow({ editor, scope, action, allowDisable }: { editor: KeybindingEditor; scope: BindingScope; action: KeybindingAction; allowDisable: boolean }) {
  const t = useT();
  const { keybindings, pendingRisk } = editor;
  const columns = allowDisable ? "minmax(150px, 1fr) 170px auto auto" : "minmax(150px, 1fr) 180px auto";
  const overrideSpan = allowDisable ? "2 / 5" : "2 / 4";
  return (
    <div style={{ display: "grid", gridTemplateColumns: columns, gap: 8, alignItems: "center" }}>
      <label htmlFor={`binding-${action}`} style={{ fontSize: "var(--fs-secondary)" }}>{t(`settings.keybindings.action.${action}`)}</label>
      <input
        id={`binding-${action}`}
        readOnly
        value={keybindings[action]}
        placeholder={allowDisable ? t("settings.terminal_interactions.disabled") : undefined}
        className="settings-shortcut-input"
        onKeyDown={(event) => editor.capture(scope, action, event)}
        aria-label={t("settings.keybindings.capture", { action: t(`settings.keybindings.action.${action}`) })}
      />
      {allowDisable && <button className="settings-action-button" onClick={() => editor.assign(action, "")}>{t("settings.terminal_interactions.disable")}</button>}
      <button className="settings-action-button" onClick={() => editor.resetOne(action)}>{t("settings.keybindings.reset_one")}</button>
      {pendingRisk?.action === action && <button className="settings-action-button" style={{ gridColumn: overrideSpan }} onClick={() => editor.assign(action, pendingRisk.binding)}>{t("settings.keybindings.override")}</button>}
    </div>
  );
}

/** Shortcuts tab: terminal interactions, advanced terminal shortcuts, the
 * global (system-wide) shortcut, and app keybindings. */
export function ShortcutsSettings() {
  const t = useT();
  const editor = useKeybindingEditor();
  const terminalSecondaryClick = useUIStore((s) => s.terminalSecondaryClick);
  const setTerminalSecondaryClick = useUIStore((s) => s.setTerminalSecondaryClick);
  const terminalHostModifier = useUIStore((s) => s.terminalHostModifier);
  const setTerminalHostModifier = useUIStore((s) => s.setTerminalHostModifier);
  const resetTerminalInteractions = useUIStore((s) => s.resetTerminalInteractions);
  const resetKeybindings = useUIStore((s) => s.resetKeybindings);
  const globalShortcut = useUIStore((s) => s.globalShortcut);
  const setGlobalShortcut = useUIStore((s) => s.setGlobalShortcut);
  const [pendingRightClickRisk, setPendingRightClickRisk] = useState(false);
  const [shortcutDraft, setShortcutDraft] = useState(globalShortcut);
  useEffect(() => setShortcutDraft(globalShortcut), [globalShortcut]);

  return (
    <div>
      <div className="settings-terminal-interactions" style={{ marginBottom: 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
          <div style={SECTION_LABEL}>{t("settings.terminal_interactions.title")}</div>
          <button className="settings-action-button" onClick={() => { resetTerminalInteractions(); setPendingRightClickRisk(false); editor.clear(); }}>
            {t("settings.terminal_interactions.reset")}
          </button>
        </div>
        <div style={{ ...SECTION_HINT, marginBottom: 10 }}>{t("settings.terminal_interactions.hint")}</div>
        <label htmlFor="terminal-secondary-click" style={{ display: "grid", gridTemplateColumns: "minmax(150px, 1fr) minmax(210px, auto)", alignItems: "center", gap: 10, fontSize: "var(--fs-secondary)" }}>
          <span>{t("settings.terminal_interactions.secondary_click")}</span>
          <select
            id="terminal-secondary-click"
            className="settings-control"
            value={terminalSecondaryClick}
            onChange={(event) => {
              const mode = event.target.value as "smart" | "menu" | "disabled";
              if (mode === "menu" && terminalSecondaryClick !== "menu") {
                setPendingRightClickRisk(true);
                return;
              }
              setPendingRightClickRisk(false);
              setTerminalSecondaryClick(mode);
            }}
          >
            <option value="smart">{t("settings.terminal_interactions.secondary_click.smart")}</option>
            <option value="menu">{t("settings.terminal_interactions.secondary_click.menu")}</option>
            <option value="disabled">{t("settings.terminal_interactions.secondary_click.disabled")}</option>
          </select>
        </label>
        {(pendingRightClickRisk || terminalSecondaryClick === "menu") && (
          <div role="alert" style={{ ...SECTION_HINT, color: "var(--c-warning)", marginTop: 8 }}>
            {t("settings.terminal_interactions.mouse_risk")}
            {pendingRightClickRisk && (
              <button className="settings-action-button" style={{ marginLeft: 8 }} onClick={() => { setTerminalSecondaryClick("menu"); setPendingRightClickRisk(false); }}>
                {t("settings.terminal_interactions.mouse_risk_confirm")}
              </button>
            )}
          </div>
        )}
        <label htmlFor="terminal-host-modifier" style={{ display: "grid", gridTemplateColumns: "minmax(150px, 1fr) minmax(210px, auto)", alignItems: "center", gap: 10, marginTop: 10, fontSize: "var(--fs-secondary)" }}>
          <span>{t("settings.appearance.host_modifier")}</span>
          <select id="terminal-host-modifier" className="settings-control" value={terminalHostModifier} onChange={(event) => setTerminalHostModifier(event.target.value as "shift" | "meta" | "alt")}>
            <option value="shift">Shift</option><option value="meta">Cmd/Meta</option><option value="alt">Alt/Option</option>
          </select>
        </label>
        <div style={SECTION_HINT}>{t("settings.appearance.host_modifier.hint")}</div>
        <div style={SECTION_HINT}>{t("settings.terminal_interactions.safe_paste_hint")}</div>
        <div style={SECTION_HINT}>{t("settings.terminal_interactions.recovery_hint")}</div>
        <details style={{ marginTop: 12 }}>
          <summary style={{ cursor: "pointer", fontSize: "var(--fs-secondary)", fontWeight: 600 }}>{t("settings.terminal_interactions.advanced")}</summary>
          {editor.message && editor.messageScope === "terminal" && <div role="alert" style={{ ...SECTION_HINT, color: "var(--c-warning)" }}>{editor.message}</div>}
          <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
            {TERMINAL_KEYBINDING_ACTIONS.map((action) => (
              <KeybindingRow key={action} editor={editor} scope="terminal" action={action} allowDisable />
            ))}
          </div>
        </details>
      </div>
      <div style={{ marginBottom: 24 }}>
        <div style={SECTION_LABEL}>{t("settings.global_shortcut.title")}</div>
        <div style={SECTION_HINT}>{t("settings.global_shortcut.hint")}</div>
        <input
          type="text"
          value={shortcutDraft}
          placeholder={t("settings.global_shortcut.placeholder")}
          onChange={(e) => setShortcutDraft(e.target.value)}
          onBlur={() => {
            const trimmed = shortcutDraft.trim();
            if (trimmed !== globalShortcut) setGlobalShortcut(trimmed);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          spellCheck={false}
          style={{ width: "100%", fontSize: "var(--fs-body)", fontFamily: "var(--font-mono)", padding: "6px 10px", background: "var(--c-bg-1)", color: "var(--c-text-2)", border: "1px solid var(--c-border-2)", borderRadius: "var(--r-btn)", outline: "none" }}
        />
      </div>
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={SECTION_LABEL}>{t("settings.keybindings.title")}</div>
          <button className="settings-action-button" onClick={() => { resetKeybindings(); editor.clear(); }}>{t("settings.keybindings.reset_all")}</button>
        </div>
        <div style={SECTION_HINT}>{t("settings.keybindings.hint")}</div>
        {editor.message && editor.messageScope === "app" && <div role="alert" style={{ ...SECTION_HINT, color: "var(--c-warning)" }}>{editor.message}</div>}
        <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
          {KEYBINDING_ACTIONS.filter((action) => !isTerminalKeybindingAction(action)).map((action) => (
            <KeybindingRow key={action} editor={editor} scope="app" action={action} allowDisable={false} />
          ))}
        </div>
      </div>
    </div>
  );
}
