import { useCallback, useEffect, useRef, useState } from "react";
import type { ThemeType, TerminalThemeName } from "../types";
import { useUIStore, type CursorStyle, type ExternalEditor, type SettingsTab, EXTERNAL_EDITORS, EDITOR_LABELS } from "@/state/ui";
import { getShellTint, isDarkTheme } from "@/styles/terminalTheme";
import { invoke } from "@tauri-apps/api/core";
import { confirm as tauriConfirmDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { platform } from "@tauri-apps/plugin-os";
import { AgentBadge } from "@/ui/agents";
import { AGENT_REGISTRY } from "@/modules/agent/registry";
import { CloseIcon, RefreshIcon } from "../shared";
import { useT, LANGUAGES, type Language } from "@/modules/i18n";
import { useFocusTrap } from "./useFocusTrap";
import { useAppUpdate } from "./useAppUpdate";
import { WorkflowsSettings } from "./WorkflowsSettings";
import { useWorkflowsStore } from "@/state/workflows";
import { focusTabById, resolveRovingTabId, tabIdFromEventTarget } from "../lib/tab-list-navigation";

interface SettingsProps {
  onClose: () => void;
}

type ResolveSource = "userOverride" | "loginShellPath" | "systemPath" | "notFound";
interface ResolvedCommand {
  name: string;
  path: string | null;
  source: ResolveSource;
}

interface Preflight {
  installed: boolean;
  loggedIn: boolean;
  hint: string | null;
}

type LegacyAgentDataState = "loading" | "missing" | "present" | "deleting" | "error";

const TABS = ["appearance", "workflows", "cli", "app"] as const;

function terminalThemePreviewColors(
  id: TerminalThemeName,
  appIsDark: boolean,
): { bg: string; fg: string } {
  if (id === "default") {
    return {
      bg: appIsDark ? "#18181b" : "#ffffff",
      fg: appIsDark ? "#e4e4e7" : "#27272a",
    };
  }
  const tint = getShellTint(id);
  return {
    bg: tint?.["--c-bg-1"] ?? (appIsDark ? "#18181b" : "#ffffff"),
    fg: tint?.["--c-text-primary"] ?? (appIsDark ? "#e4e4e7" : "#27272a"),
  };
}

let _isMac = true;
try { _isMac = platform() === "macos"; } catch { _isMac = navigator.platform.toLowerCase().includes("mac"); }

function ThemeCard({ label, themeType, selected, onClick }: { label: string; themeType: ThemeType; selected: boolean; onClick: () => void }) {
  const isDark = themeType === "dark";
  const isSystem = themeType === "system";
  const previewBg = isDark ? "#1a1a1f" : isSystem ? "linear-gradient(135deg, #fbfbfc 50%, #1a1a1f 50%)" : "#fbfbfc";
  const sidebarBg = isDark ? "rgba(255,255,255,0.08)" : isSystem ? "rgba(194,104,60,0.16)" : "#f0eff2";
  const contentBg = isDark ? "rgba(255,255,255,0.12)" : isSystem ? "rgba(255,255,255,0.72)" : "#ffffff";
  return (
    <button onClick={onClick} style={{ flex: 1, border: selected ? "2px solid var(--c-accent)" : "1px solid var(--c-border-2)", borderRadius: "var(--r-card)", padding: 0, cursor: "pointer", background: "transparent", overflow: "hidden", textAlign: "left" }}>
      <div style={{ height: 62, background: previewBg, borderBottom: "1px solid var(--c-border-2)", padding: 6, display: "flex", gap: 5 }}>
        <div style={{ width: 28, borderRadius: 4, background: sidebarBg }} />
        <div style={{ flex: 1, minWidth: 0, borderRadius: 4, background: contentBg, position: "relative", overflow: "hidden" }}>
          <div style={{ position: "absolute", left: 6, top: 8, width: 16, height: 2, borderRadius: 1, background: "var(--c-accent)", opacity: 0.7 }} />
          <div style={{ position: "absolute", left: 6, right: 6, top: 16, height: 2, borderRadius: 1, background: isDark ? "rgba(255,255,255,0.1)" : "rgba(20,20,24,0.05)" }} />
          <div style={{ position: "absolute", left: 6, right: "40%", bottom: 8, height: 2, borderRadius: 1, background: isDark ? "rgba(255,255,255,0.1)" : "rgba(20,20,24,0.05)" }} />
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 10px" }}>
        <span style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-primary)", fontWeight: selected ? 600 : 400 }}>{label}</span>
        <div style={{ width: 14, height: 14, borderRadius: "50%", border: selected ? `5px solid var(--c-accent)` : "1.5px solid var(--c-radio-ring)" }} />
      </div>
    </button>
  );
}

function AccentRing({ color, label, selected, onClick }: { color: string; label: string; selected: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} title={label} style={{ width: 26, height: 26, borderRadius: "50%", border: selected ? `2px solid ${color}` : "2px solid transparent", padding: 3, background: "transparent", cursor: "pointer", flexShrink: 0, boxShadow: "none", transition: "border-color var(--duration-fast) var(--ease-smooth)" }}>
      <div style={{ width: "100%", height: "100%", borderRadius: "50%", background: color }} />
    </button>
  );
}

const ACCENT_COLORS = [
  { color: "#c2683c", label: "Terracotta" },
  { color: "#2f9e7a", label: "Sage" },
  { color: "#4f6ef0", label: "Indigo" },
  { color: "#e0556b", label: "Rose" },
  { color: "#c4a060", label: "Sand" },
  { color: "#0f7a6a", label: "Teal" },
  { color: "#8534F3", label: "Violet" },
  { color: "#a4660a", label: "Amber" },
];

function CursorStylePicker({ value, onChange }: { value: CursorStyle; onChange: (v: CursorStyle) => void }) {
  const t = useT();
  const options: { id: CursorStyle; label: string }[] = [
    { id: "bar", label: t("settings.appearance.cursor.bar") },
    { id: "block", label: t("settings.appearance.cursor.block") },
    { id: "underline", label: t("settings.appearance.cursor.underline") },
  ];
  return (
    <div style={{ display: "flex", background: "var(--c-bg-3)", borderRadius: "var(--r-btn)", padding: 2, gap: 0 }}>
      {options.map((opt) => (
        <button
          key={opt.id} onClick={() => onChange(opt.id)}
          data-active={opt.id === value ? "true" : "false"}
          className="settings-segment"
          style={{ flex: 1, padding: "5px 12px", border: "none", borderRadius: "var(--r-btn)", background: "transparent", color: opt.id === value ? "var(--c-text-primary)" : "var(--c-text-4)", fontSize: "var(--fs-body)", fontWeight: opt.id === value ? 600 : 400, cursor: "pointer", transition: "background var(--duration-normal) var(--ease-smooth), color var(--duration-normal) var(--ease-smooth), box-shadow var(--duration-normal) var(--ease-smooth)" }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

const SECTION_LABEL: React.CSSProperties = { fontSize: "var(--fs-body)", fontWeight: 600, color: "var(--c-text-3)", marginBottom: 10 };
const SECTION_LABEL_INLINE: React.CSSProperties = { fontSize: "var(--fs-body)", fontWeight: 600, color: "var(--c-text-3)" };
const SECTION_HINT: React.CSSProperties = { fontSize: "var(--fs-secondary)", color: "var(--c-text-4)", marginTop: 6 };
const TOGGLE_ROW: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", height: 28, marginBottom: 10 };
const TOGGLE_BUTTON: React.CSSProperties = {
  width: 36, height: 20, borderRadius: 10, border: "none", padding: 2, cursor: "pointer",
  display: "flex", alignItems: "center", flexShrink: 0,
  transition: "background var(--duration-normal) var(--ease-smooth)",
};
const TOGGLE_KNOB: React.CSSProperties = {
  width: 16, height: 16, borderRadius: "50%", background: "var(--c-bg-white)",
  boxShadow: "var(--shadow-card)",
  transition: "transform var(--duration-normal) var(--ease-out-back)",
};

const CLI_LIST = AGENT_REGISTRY.map(({ code, name, cliBin }) => ({ code, name, cliBin }));

const SOURCE_LABEL_KEYS: Record<ResolveSource, string> = {
  userOverride: "settings.cli.source.user_override",
  loginShellPath: "settings.cli.source.login_shell_path",
  systemPath: "settings.cli.source.system_path",
  notFound: "settings.cli.source.not_found",
};

export function Settings({ onClose }: SettingsProps) {
  const t = useT();
  const activeTab = useUIStore((s) => s.settingsTab);
  const setActiveTab = useUIStore((s) => s.setSettingsTab);
  const language = useUIStore((s) => s.language);
  const setLanguage = useUIStore((s) => s.setLanguage);
  const globalShortcut = useUIStore((s) => s.globalShortcut);
  const setGlobalShortcut = useUIStore((s) => s.setGlobalShortcut);
  const [shortcutDraft, setShortcutDraft] = useState(globalShortcut);
  useEffect(() => setShortcutDraft(globalShortcut), [globalShortcut]);
  const theme = useUIStore((s) => s.theme);
  const accent = useUIStore((s) => s.accent);
  const cursorStyle = useUIStore((s) => s.cursorStyle);
  const cursorBlink = useUIStore((s) => s.cursorBlink);
  const fontSize = useUIStore((s) => s.fontSize);
  const fontFamily = useUIStore((s) => s.fontFamily);
  const fontLigatures = useUIStore((s) => s.fontLigatures);
  const nerdFontFallback = useUIStore((s) => s.nerdFontFallback);
  const scrollback = useUIStore((s) => s.scrollback);
  const setTheme = useUIStore((s) => s.setTheme);
  const setAccent = useUIStore((s) => s.setAccent);
  const setCursorStyle = useUIStore((s) => s.setCursorStyle);
  const setCursorBlink = useUIStore((s) => s.setCursorBlink);
  const setFontSize = useUIStore((s) => s.setFontSize);
  const setFontFamily = useUIStore((s) => s.setFontFamily);
  const setFontLigatures = useUIStore((s) => s.setFontLigatures);
  const setNerdFontFallback = useUIStore((s) => s.setNerdFontFallback);
  const setScrollback = useUIStore((s) => s.setScrollback);
  const terminalTheme = useUIStore((s) => s.terminalTheme);
  const setTerminalTheme = useUIStore((s) => s.setTerminalTheme);
  const externalEditor = useUIStore((s) => s.externalEditor);
  const setExternalEditor = useUIStore((s) => s.setExternalEditor);
  const bellNotification = useUIStore((s) => s.bellNotification);
  const setBellNotification = useUIStore((s) => s.setBellNotification);
  const terminalClipboardWrite = useUIStore((s) => s.terminalClipboardWrite);
  const setTerminalClipboardWrite = useUIStore((s) => s.setTerminalClipboardWrite);
  const terminalInlineImages = useUIStore((s) => s.terminalInlineImages);
  const setTerminalInlineImages = useUIStore((s) => s.setTerminalInlineImages);
  const configPath = useUIStore((s) => s.configPath);
  const configError = useUIStore((s) => s.configError);

  const isDark = isDarkTheme(theme);
  // Subscribe to the workflow count so the footer "clear all" button's
  // disabled state stays reactive (getState() in render wouldn't re-render
  // when workflows change, leaving the button enabled after a clear).
  const workflowCount = useWorkflowsStore((s) => s.workflows.length);
  const [fontDraft, setFontDraft] = useState(fontFamily);
  const sheetRef = useRef<HTMLDivElement>(null);
  useEffect(() => { sheetRef.current?.focus(); }, []);
  useFocusTrap(sheetRef);
  useEffect(() => { setFontDraft(fontFamily); }, [fontFamily]);
  const [resolvedClis, setResolvedClis] = useState<ResolvedCommand[] | null>(null);
  const [cliError, setCliError] = useState(false);
  const [preflights, setPreflights] = useState<Record<string, Preflight>>({});
  const [editingOverride, setEditingOverride] = useState<string | null>(null);
  const [overrideDraft, setOverrideDraft] = useState("");
  const cliLoadStartedRef = useRef(false);
  const { appVersion, updateStatus, updateVersion, updateProgress, canInstallUpdate, checkForUpdates, installUpdate } = useAppUpdate(activeTab);
  const [legacyAgentDataState, setLegacyAgentDataState] = useState<LegacyAgentDataState>("loading");

  const loadLegacyAgentDataStatus = useCallback(() => {
    setLegacyAgentDataState("loading");
    invoke<"missing" | "present">("legacy_agent_data_status")
      .then(setLegacyAgentDataState)
      .catch(() => setLegacyAgentDataState("error"));
  }, []);

  useEffect(() => {
    if (activeTab !== "app") return;
    loadLegacyAgentDataStatus();
  }, [activeTab, loadLegacyAgentDataStatus]);

  const deleteLegacyAgentData = useCallback(async () => {
    const confirmed = await tauriConfirmDialog(t("settings.app.legacy_agent_data.confirm"), { kind: "warning" });
    if (!confirmed) return;
    setLegacyAgentDataState("deleting");
    invoke<"missing">("legacy_agent_data_delete", { confirmed: true })
      .then(() => setLegacyAgentDataState("missing"))
      .catch(() => setLegacyAgentDataState("error"));
  }, [t]);

  const loadPreflights = useCallback((items: ResolvedCommand[]) => {
    // Only check login state for CLIs that are actually installed — an auth
    // probe on a missing binary is pointless and slow. Each call is cached
    // 30 min backend-side, so refreshing is cheap.
    const installed = items.filter((cli) => !!cli.path);
    setPreflights({});
    installed.forEach((cli) => {
      invoke<Preflight>("agent_preflight", { agent: cli.name })
        .then((pf) => setPreflights((prev) => ({ ...prev, [cli.name]: pf })))
        .catch(() => {});
    });
  }, []);

  const loadCliStatus = useCallback(() => {
    setResolvedClis(null);
    setCliError(false);
    invoke<ResolvedCommand[]>("resolve_all_bins")
      .then((items) => {
        setResolvedClis(items);
        setCliError(false);
        loadPreflights(items);
      })
      .catch(() => {
        setResolvedClis([]);
        setCliError(true);
      });
  }, [loadPreflights]);

  useEffect(() => {
    if (activeTab !== "cli" || cliLoadStartedRef.current) return;
    cliLoadStartedRef.current = true;
    loadCliStatus();
  }, [activeTab, loadCliStatus]);

  const applyOverride = useCallback((code: string, cliBin: string, path: string) => {
    const trimmed = path.trim();
    setEditingOverride(null);
    if (!trimmed) return;
    // The resolver keys overrides by cli_bin (resolve_all_bins resolves cli_bin
    // then relabels name=code), so the override must be stored under cliBin, not
    // the agent code, or it would never take effect. Then invalidate the
    // preflight cache for this agent and re-resolve so the new path + login
    // state show immediately.
    invoke("set_bin_override", { name: cliBin, path: trimmed })
      .then(() => invoke("agent_preflight_invalidate", { agent: code }).catch(() => {}))
      .then(() => loadCliStatus())
      .catch(() => {});
  }, [loadCliStatus]);

  const resolvedByCode = new Map((resolvedClis ?? []).map((cli) => [cli.name, cli]));
  const installedCliCount = CLI_LIST.filter(({ code }) => !!resolvedByCode.get(code)?.path).length;
  const updateBusy = updateStatus === "checking" || updateStatus === "downloading" || updateStatus === "restarting";

  // APG tabs 键盘漫游（自动激活）：方向键/Home/End 在设置页签间循环
  const handleTabListKeyDown = (e: React.KeyboardEvent) => {
    const currentId = tabIdFromEventTarget(e.target);
    if (!currentId) return;
    const nextId = resolveRovingTabId(TABS, currentId, e.key);
    if (!nextId || nextId === currentId) return;
    e.preventDefault();
    setActiveTab(nextId as SettingsTab);
    focusTabById(e.currentTarget as HTMLElement, nextId);
  };

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "var(--backdrop-color)", zIndex: 200, animation: "fadeIn var(--duration-normal) var(--ease-smooth)" }} />
      <div
        ref={sheetRef} tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onKeyDown={(e: React.KeyboardEvent) => { if (e.key === "Escape") onClose(); }}
        style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)", width: 600, maxWidth: "calc(100vw - 32px)", background: "var(--c-bg-white)", borderRadius: "var(--r-overlay)", boxShadow: "var(--shadow-overlay)", zIndex: 201, animation: "sheetIn var(--duration-normal) var(--ease-out-back)", overflow: "hidden", display: "flex", flexDirection: "column", maxHeight: "80vh", outline: "none" }}>
        <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid var(--c-border-1)", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <span id="settings-title" style={{ fontSize: "var(--fs-title)", fontWeight: 700, color: "var(--c-text-primary)" }}>{t("settings.title")}</span>
            <button onClick={onClose} aria-label={t("common.close")} style={{ width: 26, height: 26, border: "none", background: "transparent", cursor: "pointer", color: "var(--c-text-4)", borderRadius: "var(--r-btn)", display: "flex", alignItems: "center", justifyContent: "center" }} className="hover-bg">
              <CloseIcon size={13} strokeWidth={2.2} />
            </button>
          </div>
          <div
            className="no-scrollbar"
            role="tablist"
            aria-label={t("settings.title")}
            onKeyDown={handleTabListKeyDown}
            style={{ display: "flex", gap: 18, borderBottom: "1px solid var(--c-border-1)", overflowX: "auto", overscrollBehaviorX: "contain", scrollSnapType: "x proximity" }}
          >
            {TABS.map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                role="tab"
                aria-selected={activeTab === tab}
                aria-controls="settings-tabpanel"
                data-tab-id={tab}
                tabIndex={activeTab === tab ? 0 : -1}
                data-active={activeTab === tab ? "true" : "false"}
                className="settings-tab-pill"
                style={{ padding: "5px 0 8px", marginBottom: -1, border: "none", background: "transparent", color: activeTab === tab ? "var(--c-text-primary)" : "var(--c-text-4)", fontSize: "var(--fs-body)", fontWeight: activeTab === tab ? 600 : 400, cursor: "pointer", transition: "color var(--duration-fast) var(--ease-smooth)", whiteSpace: "nowrap", flexShrink: 0, scrollSnapAlign: "start" }}
              >
                {t(`settings.tabs.${tab}`)}
              </button>
            ))}
          </div>
        </div>

        <div role="tabpanel" id="settings-tabpanel" style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }} className="no-scrollbar scroll-fade-y">
          {activeTab === "appearance" && (
            <div>
              <div style={{ marginBottom: 24 }}>
                <div style={SECTION_LABEL}>{t("settings.appearance.theme")}</div>
                <div style={{ display: "flex", gap: 10 }}>
                  <ThemeCard label={t("settings.appearance.theme.light")} themeType="light" selected={theme === "light"} onClick={() => setTheme("light")} />
                  <ThemeCard label={t("settings.appearance.theme.dark")} themeType="dark" selected={theme === "dark"} onClick={() => setTheme("dark")} />
                  <ThemeCard label={t("settings.appearance.theme.system")} themeType="system" selected={theme === "system"} onClick={() => setTheme("system")} />
                </div>
              </div>
              <div style={{ marginBottom: 24 }}>
                <div style={SECTION_LABEL}>{t("settings.appearance.accent")}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {ACCENT_COLORS.map((ac) => (
                    <AccentRing key={ac.color} color={ac.color} label={ac.label} selected={accent === ac.color} onClick={() => setAccent(ac.color)} />
                  ))}
                  <span style={{ marginLeft: "auto", fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)" }}>
                    {ACCENT_COLORS.find((ac) => ac.color === accent)?.label ?? accent}
                  </span>
                </div>
              </div>
              <div style={{ marginBottom: 24 }}>
                <div style={TOGGLE_ROW}>
                  <span style={SECTION_LABEL_INLINE}>{t("settings.appearance.cursor_style")}</span>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                    <span style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-4)" }}>{t("settings.appearance.cursor_blink")}</span>
                    <button
                      onClick={() => setCursorBlink(!cursorBlink)}
                      role="switch"
                      aria-checked={cursorBlink}
                      aria-label={t("settings.appearance.cursor_blink")}
                      style={{ ...TOGGLE_BUTTON, background: cursorBlink ? "var(--c-accent)" : "var(--c-bg-3)" }}
                    >
                      <div style={{ ...TOGGLE_KNOB, transform: cursorBlink ? "translateX(16px)" : "translateX(0)" }} />
                    </button>
                  </label>
                </div>
                <CursorStylePicker value={cursorStyle} onChange={setCursorStyle} />
              </div>
              <div style={{ marginBottom: 24 }}>
                <div style={SECTION_LABEL}>{t("settings.appearance.font_size")}</div>
                <div style={{ display: "inline-flex", alignItems: "center", border: "1px solid var(--c-border-2)", borderRadius: "var(--r-btn)", overflow: "hidden" }}>
                  <button onClick={() => setFontSize(Math.max(10, fontSize - 1))} className="hover-bg" style={{ width: 32, height: 30, border: "none", borderRight: "1px solid var(--c-border-2)", background: "var(--c-bg-white)", color: "var(--c-text-2)", fontSize: "var(--fs-title)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>−</button>
                  <span style={{ minWidth: 48, textAlign: "center", fontSize: "var(--fs-body)", fontFamily: "var(--font-mono)", color: "var(--c-text-primary)", padding: "0 4px" }}>{fontSize}px</span>
                  <button onClick={() => setFontSize(Math.min(22, fontSize + 1))} className="hover-bg" style={{ width: 32, height: 30, border: "none", borderLeft: "1px solid var(--c-border-2)", background: "var(--c-bg-white)", color: "var(--c-text-2)", fontSize: "var(--fs-title)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
                </div>
              </div>
              <div style={{ marginBottom: 24 }}>
                <div style={SECTION_LABEL}>{t("settings.appearance.font_family")}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <input
                    value={fontDraft}
                    onChange={(e) => setFontDraft(e.target.value)}
                    onBlur={() => setFontFamily(fontDraft)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        setFontFamily(fontDraft);
                        e.currentTarget.blur();
                      }
                    }}
                    spellCheck={false}
                    style={{ flex: "1 1 260px", minWidth: 0, height: 30, border: "1px solid var(--c-border-2)", borderRadius: "var(--r-btn)", background: "var(--c-bg-white)", color: "var(--c-text-primary)", padding: "0 10px", fontFamily: "var(--font-mono)", fontSize: "var(--fs-body)", outline: "none" }}
                  />
                  <button
                    onClick={() => setNerdFontFallback(!nerdFontFallback)}
                    style={{
                      height: 30, padding: "0 10px", borderRadius: "var(--r-btn)", border: "1px solid var(--c-border-2)", cursor: "pointer",
                      background: nerdFontFallback ? "var(--c-accent)" : "var(--c-bg-white)",
                      color: nerdFontFallback ? "var(--c-btn-primary-text)" : "var(--c-text-3)",
                      fontSize: "var(--fs-secondary)", fontWeight: 600, flexShrink: 0,
                    }}
                  >
                    {t("settings.appearance.nerd_font")}
                  </button>
                  <button
                    onClick={() => setFontLigatures(!fontLigatures)}
                    style={{
                      height: 30, padding: "0 10px", borderRadius: "var(--r-btn)", border: "1px solid var(--c-border-2)", cursor: "pointer",
                      background: fontLigatures ? "var(--c-accent)" : "var(--c-bg-white)",
                      color: fontLigatures ? "var(--c-btn-primary-text)" : "var(--c-text-3)",
                      fontSize: "var(--fs-secondary)", fontWeight: 600, flexShrink: 0,
                    }}
                  >
                    {t("settings.appearance.ligatures")}
                  </button>
                </div>
                <div style={{ ...SECTION_HINT, marginTop: 6 }}>
                  {t("settings.appearance.font_family.suggest")}
                </div>
              </div>
              <div style={{ marginBottom: 24 }}>
                <div style={SECTION_LABEL}>{t("settings.appearance.scrollback")}</div>
                <div style={{ display: "inline-flex", alignItems: "center", border: "1px solid var(--c-border-2)", borderRadius: "var(--r-btn)", overflow: "hidden" }}>
                  <button onClick={() => setScrollback(Math.max(1000, scrollback - 1000))} className="hover-bg" style={{ width: 32, height: 30, border: "none", borderRight: "1px solid var(--c-border-2)", background: "var(--c-bg-white)", color: "var(--c-text-2)", fontSize: "var(--fs-title)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>−</button>
                  <span style={{ minWidth: 64, textAlign: "center", fontSize: "var(--fs-body)", fontFamily: "var(--font-mono)", color: "var(--c-text-primary)", padding: "0 4px" }}>{scrollback}</span>
                  <button onClick={() => setScrollback(Math.min(20000, scrollback + 1000))} className="hover-bg" style={{ width: 32, height: 30, border: "none", borderLeft: "1px solid var(--c-border-2)", background: "var(--c-bg-white)", color: "var(--c-text-2)", fontSize: "var(--fs-title)", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
                </div>
              </div>
              <div style={{ marginBottom: 24 }}>
                <div style={TOGGLE_ROW}>
                  <span style={SECTION_LABEL_INLINE}>{t("settings.appearance.bell_notification")}</span>
                  <button
                    onClick={() => setBellNotification(!bellNotification)}
                    role="switch"
                    aria-checked={bellNotification}
                    aria-label={t("settings.appearance.bell_notification")}
                    style={{ ...TOGGLE_BUTTON, background: bellNotification ? "var(--c-accent)" : "var(--c-bg-3)" }}
                  >
                    <div style={{ ...TOGGLE_KNOB, transform: bellNotification ? "translateX(16px)" : "translateX(0)" }} />
                  </button>
                </div>
                <div style={SECTION_HINT}>{t("settings.appearance.bell_notification.hint")}</div>
              </div>
              <div style={{ marginBottom: 24 }}>
                <div style={TOGGLE_ROW}>
                  <span style={SECTION_LABEL_INLINE}>{t("settings.appearance.clipboard_write")}</span>
                  <button
                    onClick={() => setTerminalClipboardWrite(!terminalClipboardWrite)}
                    role="switch"
                    aria-checked={terminalClipboardWrite}
                    aria-label={t("settings.appearance.clipboard_write")}
                    style={{ ...TOGGLE_BUTTON, background: terminalClipboardWrite ? "var(--c-accent)" : "var(--c-bg-3)" }}
                  >
                    <div style={{ ...TOGGLE_KNOB, transform: terminalClipboardWrite ? "translateX(16px)" : "translateX(0)" }} />
                  </button>
                </div>
                <div style={SECTION_HINT}>{t("settings.appearance.clipboard_write.hint")}</div>
              </div>
              <div style={{ marginBottom: 24 }}>
                <div style={TOGGLE_ROW}>
                  <span style={SECTION_LABEL_INLINE}>{t("settings.appearance.inline_images")}</span>
                  <button
                    onClick={() => setTerminalInlineImages(!terminalInlineImages)}
                    role="switch"
                    aria-checked={terminalInlineImages}
                    aria-label={t("settings.appearance.inline_images")}
                    style={{ ...TOGGLE_BUTTON, background: terminalInlineImages ? "var(--c-accent)" : "var(--c-bg-3)" }}
                  >
                    <div style={{ ...TOGGLE_KNOB, transform: terminalInlineImages ? "translateX(16px)" : "translateX(0)" }} />
                  </button>
                </div>
                <div style={SECTION_HINT}>{t("settings.appearance.inline_images.hint")}</div>
              </div>
              {_isMac && (
                <div style={{ marginBottom: 24 }}>
                  <div style={TOGGLE_ROW}>
                    <span style={SECTION_LABEL_INLINE}>{t("settings.privacy.title")}</span>
                    <button
                      onClick={() => {
                        openUrl("x-apple.systempreferences:com.apple.preference.security?Privacy_Files").catch(() => {});
                      }}
                      style={{
                        height: 28, padding: "0 12px", borderRadius: "var(--r-btn)",
                        border: "1px solid var(--c-border-2)", background: "var(--c-bg-white)",
                        color: "var(--c-text-2)", fontSize: "var(--fs-secondary)",
                        fontWeight: 500, cursor: "pointer", flexShrink: 0,
                      }}
                    >
                      {t("settings.privacy.open_system")}
                    </button>
                  </div>
                  <div style={SECTION_HINT}>{t("settings.privacy.hint")}</div>
                </div>
              )}
              <div>
                <div style={SECTION_LABEL}>{t("settings.appearance.terminal_theme")}</div>
                <div style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-4)", marginBottom: 8, marginTop: -4 }}>{t("settings.appearance.terminal_theme.hint")}</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(118px, 1fr))", gap: 8 }}>
                  {([
                    { id: "default" as TerminalThemeName, label: t("settings.appearance.terminal_theme.default") },
                    { id: "github-light" as TerminalThemeName, label: "GitHub" },
                    { id: "rose-pine-dawn" as TerminalThemeName, label: "Dawn" },
                    { id: "catppuccin" as TerminalThemeName, label: "Catppuccin" },
                    { id: "tokyo-night" as TerminalThemeName, label: "Tokyo Night" },
                    { id: "one-dark" as TerminalThemeName, label: "One Dark" },
                    { id: "solarized" as TerminalThemeName, label: "Solarized" },
                  ]).map((entry) => {
                    const { bg, fg } = terminalThemePreviewColors(entry.id, isDark);
                    return (
                    <button
                      key={entry.id}
                      onClick={() => setTerminalTheme(entry.id)}
                      style={{
                        width: "100%",
                        border: terminalTheme === entry.id ? "2px solid var(--c-accent)" : "1px solid var(--c-border-2)",
                        borderRadius: "var(--r-card)",
                        padding: 0,
                        cursor: "pointer",
                        background: "transparent",
                        overflow: "hidden",
                        textAlign: "left",
                      }}
                    >
                      <div style={{ height: 40, background: bg, display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 8px", gap: 2.5 }}>
                        {[{ w: 18, o: 0.35 }, { w: 45, o: 0.6 }, { w: 60, o: 0.45 }, { w: 35, o: 0.5 }, { w: 25, o: 0.3 }].map((line) => (
                          <div key={`${line.w}-${line.o}`} style={{ height: 2.5, width: `${line.w}%`, borderRadius: 1, background: fg, opacity: line.o }} />
                        ))}
                      </div>
                      <div style={{ padding: "4px 8px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-primary)", fontWeight: terminalTheme === entry.id ? 600 : 400 }}>{entry.label}</span>
                        {terminalTheme === entry.id && <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--c-accent)" }} />}
                      </div>
                    </button>
                    );
                  })}
                </div>
              </div>
              <div style={{ marginTop: 24 }}>
                <div style={SECTION_LABEL}>{t("settings.appearance.external_editor")}</div>
                <div style={{ display: "flex", background: "var(--c-bg-3)", borderRadius: "var(--r-btn)", padding: 2, gap: 0 }}>
                  {EXTERNAL_EDITORS.map((ed: ExternalEditor) => (
                    <button
                      key={ed}
                      onClick={() => setExternalEditor(ed)}
                      data-active={ed === externalEditor ? "true" : "false"}
                      className="settings-segment"
                      style={{ flex: 1, padding: "5px 12px", border: "none", borderRadius: "var(--r-btn)", background: "transparent", color: ed === externalEditor ? "var(--c-text-primary)" : "var(--c-text-4)", fontSize: "var(--fs-body)", fontWeight: ed === externalEditor ? 600 : 400, cursor: "pointer", transition: "background var(--duration-normal) var(--ease-smooth), color var(--duration-normal) var(--ease-smooth), box-shadow var(--duration-normal) var(--ease-smooth)" }}
                    >
                      {EDITOR_LABELS[ed]}
                    </button>
                  ))}
                </div>
              </div>
              <div style={{ marginTop: 24 }}>
                <div style={SECTION_LABEL}>{t("settings.appearance.language")}</div>
                <div style={{ display: "flex", background: "var(--c-bg-3)", borderRadius: "var(--r-btn)", padding: 2, gap: 0 }}>
                  {LANGUAGES.map((lang: Language) => (
                    <button
                      key={lang}
                      onClick={() => setLanguage(lang)}
                      data-active={lang === language ? "true" : "false"}
                      className="settings-segment"
                      style={{ flex: 1, padding: "5px 12px", border: "none", borderRadius: "var(--r-btn)", background: "transparent", color: lang === language ? "var(--c-text-primary)" : "var(--c-text-4)", fontSize: "var(--fs-body)", fontWeight: lang === language ? 600 : 400, cursor: "pointer", transition: "background var(--duration-normal) var(--ease-smooth), color var(--duration-normal) var(--ease-smooth), box-shadow var(--duration-normal) var(--ease-smooth)" }}
                    >
                      {lang === "system" ? t("settings.appearance.language.system") : lang === "zh-CN" ? t("settings.appearance.language.zh_cn") : t("settings.appearance.language.en")}
                    </button>
                  ))}
                </div>
              </div>
              <div style={{ marginTop: 24 }}>
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
            </div>
          )}

          {activeTab === "workflows" && (
            <div>
              <WorkflowsSettings />
            </div>
          )}

          {activeTab === "cli" && (
            <div style={{ color: "var(--c-text-4)", fontSize: "var(--fs-body)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ ...SECTION_LABEL, marginBottom: 4 }}>{t("settings.cli.path_label")}</div>
                  <div style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)" }}>
                    {resolvedClis === null ? t("settings.cli.scanning") : t("settings.cli.found", { count: installedCliCount, total: CLI_LIST.length })}
                  </div>
                </div>
                <button
                  onClick={loadCliStatus}
                  className="hover-bg"
                  disabled={resolvedClis === null}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    padding: "5px 9px",
                    borderRadius: "var(--r-btn)",
                    border: "1px solid var(--c-border-2)",
                    background: "var(--c-bg-white)",
                    color: "var(--c-text-3)",
                    fontSize: "var(--fs-secondary)",
                    cursor: resolvedClis === null ? "default" : "pointer",
                    opacity: resolvedClis === null ? 0.55 : 1,
                    flexShrink: 0,
                  }}
                >
                  <RefreshIcon size={12} />
                  {t("settings.cli.refresh")}
                </button>
              </div>
              {resolvedClis === null && (
                <div style={{ fontSize: "var(--fs-body)", color: "var(--c-text-5)" }}>{t("settings.cli.detecting")}</div>
              )}
              {cliError && (
                <div style={{ fontSize: "var(--fs-body)", color: "var(--c-error)", marginBottom: 10 }}>
                  {t("settings.cli.error")}
                </div>
              )}
              {resolvedClis !== null && (
                <div style={{ display: "flex", flexDirection: "column" }}>
                  {CLI_LIST.map(({ code, name, cliBin }) => {
                    const cli = resolvedByCode.get(code);
                    const installed = !!cli?.path;
                    const source = cli?.source ?? "notFound";
                    const pf = preflights[code];
                    const isEditing = editingOverride === code;
                    return (
                      <div key={code} style={{ padding: "8px 0", borderBottom: "1px solid var(--c-border-1)" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <AgentBadge agent={code} size={28} disabled={!installed} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <span style={{ fontSize: "var(--fs-body)", fontWeight: 600, color: "var(--c-text-2)" }}>{name}</span>
                              {installed && pf && !pf.loggedIn && (
                                <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-warning)", fontWeight: 600, flexShrink: 0 }}>
                                  {t("settings.cli.not_logged_in")}
                                </span>
                              )}
                            </div>
                            <div style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-4)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 1 }}>
                              {installed ? cli?.path : t("settings.cli.not_on_path")}
                            </div>
                          </div>
                          <span style={{ fontSize: "var(--fs-meta)", color: installed ? "var(--c-success)" : "var(--c-text-5)", fontWeight: 600, flexShrink: 0 }}>
                            {installed ? t(SOURCE_LABEL_KEYS[source]) : t("settings.cli.source.not_found")}
                          </span>
                          <button
                            onClick={() => {
                              setEditingOverride(isEditing ? null : code);
                              setOverrideDraft(cli?.path ?? "");
                            }}
                            className="hover-bg"
                            title={t("settings.cli.override")}
                            aria-label={t("settings.cli.override")}
                            style={{ width: 24, height: 24, borderRadius: "var(--r-btn)", border: "none", background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color: isEditing ? "var(--c-accent)" : "var(--c-text-5)" }}
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M12 20h9" />
                              <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
                            </svg>
                          </button>
                        </div>
                        {isEditing && (
                          <div style={{ display: "flex", gap: 6, marginTop: 8, paddingLeft: 38 }}>
                            <input
                              value={overrideDraft}
                              onChange={(e) => setOverrideDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") { e.preventDefault(); applyOverride(code, cliBin, overrideDraft); }
                                else if (e.key === "Escape") { e.preventDefault(); setEditingOverride(null); }
                              }}
                              autoFocus
                              spellCheck={false}
                              placeholder={t("settings.cli.override_placeholder")}
                              style={{ flex: 1, minWidth: 0, height: 30, border: "1px solid var(--c-border-2)", borderRadius: "var(--r-btn)", background: "var(--c-bg-white)", color: "var(--c-text-primary)", padding: "0 10px", fontFamily: "var(--font-mono)", fontSize: "var(--fs-secondary)", outline: "none" }}
                            />
                            <button
                              onClick={() => applyOverride(code, cliBin, overrideDraft)}
                              className="hover-bg"
                              style={{ padding: "0 12px", height: 30, borderRadius: "var(--r-btn)", border: "1px solid var(--c-accent-border)", background: "var(--c-accent-bg-light)", color: "var(--c-accent)", fontSize: "var(--fs-secondary)", fontWeight: 600, cursor: "pointer", flexShrink: 0 }}
                            >
                              {t("settings.cli.override_save")}
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {activeTab === "app" && (
            <div style={{ color: "var(--c-text-3)", fontSize: "var(--fs-body)" }}>
              <div style={{ paddingBottom: 20, borderBottom: "1px solid var(--c-border-1)" }}>
                <div style={SECTION_LABEL}>{t("settings.app.version")}</div>
                <div style={{ fontFamily: "var(--font-mono)", color: "var(--c-text-primary)", fontSize: "var(--fs-title)", fontWeight: 600 }}>
                  Tunara {appVersion ? `v${appVersion}` : ""}
                </div>
              </div>
              <div style={{ paddingTop: 20 }}>
                <div style={SECTION_LABEL}>{t("settings.app.updates")}</div>
                <div style={{ ...SECTION_HINT, marginBottom: 14 }}>{t("settings.app.updates.hint")}</div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 16,
                    padding: "12px 0",
                    borderTop: "1px solid var(--c-border-1)",
                    borderBottom: "1px solid var(--c-border-1)",
                    background: updateStatus === "error" ? "var(--c-error-bg)" : "transparent",
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ color: updateStatus === "error" ? "var(--c-error)" : "var(--c-text-primary)", fontWeight: 600, marginBottom: 3 }}>
                      {updateStatus === "checking" ? t("settings.app.updates.checking")
                        : updateStatus === "current" ? t("settings.app.updates.current")
                        : updateStatus === "available" || updateStatus === "downloading" || updateStatus === "restarting" ? t("settings.app.updates.available", { version: updateVersion })
                        : updateStatus === "error" ? t("settings.app.updates.error")
                        : t("settings.app.updates.ready")}
                    </div>
                    {(updateStatus === "downloading" || updateStatus === "restarting") && (
                      <div style={{ color: "var(--c-text-4)", fontSize: "var(--fs-meta)" }}>
                        {updateStatus === "restarting"
                          ? t("settings.app.updates.restarting")
                          : updateProgress === null
                            ? t("settings.app.updates.downloading")
                            : t("settings.app.updates.progress", { progress: updateProgress })}
                      </div>
                    )}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 7, flexShrink: 0 }}>
                    {updateStatus === "error" && (
                      <button
                        onClick={() => { void openUrl("https://github.com/24kHandsome1201/tunara/releases/latest"); }}
                        className="hover-bg"
                        style={{ padding: "7px 10px", borderRadius: "var(--r-btn)", border: "1px solid var(--c-border-2)", background: "var(--c-bg-white)", color: "var(--c-text-3)", fontSize: "var(--fs-secondary)", fontWeight: 600, cursor: "pointer" }}
                      >
                        {t("settings.app.updates.open_releases")}
                      </button>
                    )}
                    <button
                      onClick={() => { void (canInstallUpdate ? installUpdate() : checkForUpdates()); }}
                      disabled={updateBusy}
                      className={canInstallUpdate ? "hover-primary" : "hover-bg"}
                      style={{ padding: "7px 12px", borderRadius: "var(--r-btn)", border: canInstallUpdate ? "none" : "1px solid var(--c-border-2)", background: canInstallUpdate ? "var(--c-btn-primary-bg)" : "var(--c-bg-white)", color: canInstallUpdate ? "var(--c-btn-primary-text)" : "var(--c-text-2)", fontSize: "var(--fs-secondary)", fontWeight: 600, cursor: updateBusy ? "wait" : "pointer" }}
                    >
                      {canInstallUpdate ? t("settings.app.updates.install") : updateStatus === "error" ? t("settings.app.updates.retry") : t("settings.app.updates.check")}
                    </button>
                  </div>
                </div>
              </div>
              {(legacyAgentDataState === "present" || legacyAgentDataState === "deleting" || legacyAgentDataState === "error") && (
                <div style={{ paddingTop: 20 }} aria-live="polite">
                  <div style={SECTION_LABEL}>{t("settings.app.legacy_agent_data.title")}</div>
                  {legacyAgentDataState === "error" ? (
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
                      <div style={{ ...SECTION_HINT, color: "var(--c-error)", marginBottom: 0 }}>
                        {t("settings.app.legacy_agent_data.error")}
                      </div>
                      <button
                        onClick={loadLegacyAgentDataStatus}
                        className="hover-bg"
                        style={{ padding: "7px 12px", borderRadius: "var(--r-btn)", border: "1px solid var(--c-border-2)", background: "var(--c-bg-white)", color: "var(--c-text-2)", fontSize: "var(--fs-secondary)", fontWeight: 600, cursor: "pointer", flexShrink: 0 }}
                      >
                        {t("settings.app.legacy_agent_data.retry")}
                      </button>
                    </div>
                  ) : (
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
                      <div style={{ ...SECTION_HINT, marginBottom: 0 }}>
                        {t("settings.app.legacy_agent_data.hint")}
                      </div>
                      <button
                        onClick={() => { void deleteLegacyAgentData(); }}
                        disabled={legacyAgentDataState === "deleting"}
                        className="hover-bg"
                        style={{ padding: "7px 12px", borderRadius: "var(--r-btn)", border: "1px solid var(--c-error)", background: "transparent", color: "var(--c-error)", fontSize: "var(--fs-secondary)", fontWeight: 600, cursor: legacyAgentDataState === "deleting" ? "wait" : "pointer", flexShrink: 0 }}
                      >
                        {legacyAgentDataState === "deleting"
                          ? t("settings.app.legacy_agent_data.deleting")
                          : t("settings.app.legacy_agent_data.delete")}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ borderTop: "1px solid var(--c-border-1)", padding: "12px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          {activeTab === "appearance" ? (
            <button
              onClick={async () => {
                const ok = await tauriConfirmDialog(t("settings.appearance.reset_confirm"), { kind: "warning" });
                if (!ok) return;
                useUIStore.getState().resetAppearance();
              }}
              style={{ padding: "6px 14px", borderRadius: "var(--r-btn)", border: "1px solid var(--c-border-2)", background: "transparent", color: "var(--c-text-4)", fontSize: "var(--fs-secondary)", cursor: "pointer" }}
              className="hover-bg"
            >
              {t("common.reset_defaults")}
            </button>
          ) : activeTab === "workflows" ? (
            <button
              onClick={async () => {
                // wry's WKWebView renders no JS dialog UI, so use the Tauri
                // dialog plugin (the paste-protection confirmer uses it too).
                const ok = await tauriConfirmDialog(t("settings.workflows.clear_all.confirm"), { kind: "warning" });
                if (!ok) return;
                const workflows = useWorkflowsStore.getState().workflows;
                for (const w of workflows) useWorkflowsStore.getState().removeWorkflow(w.id);
              }}
              disabled={workflowCount === 0}
              style={{ padding: "6px 14px", borderRadius: "var(--r-btn)", border: "1px solid var(--c-border-2)", background: "transparent", color: "var(--c-text-4)", fontSize: "var(--fs-secondary)", cursor: "pointer" }}
              className="hover-bg"
            >
              {t("settings.workflows.clear_all")}
            </button>
          ) : activeTab === "cli" ? (
            <button
              onClick={async () => {
                const ok = await tauriConfirmDialog(t("settings.cli.reset_overrides.confirm"), { kind: "warning" });
                if (!ok) return;
                invoke("clear_bin_overrides")
                  .then(() => loadCliStatus())
                  .catch(() => {});
              }}
              style={{ padding: "6px 14px", borderRadius: "var(--r-btn)", border: "1px solid var(--c-border-2)", background: "transparent", color: "var(--c-text-4)", fontSize: "var(--fs-secondary)", cursor: "pointer" }}
              className="hover-bg"
            >
              {t("settings.cli.reset_overrides")}
            </button>
          ) : <span />}
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            {configError ? (
              <span title={configError} style={{ fontSize: "var(--fs-meta)", color: "var(--c-error)", fontFamily: "var(--font-mono)", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t("settings.config_error")}</span>
            ) : configPath ? (
              <span title={configPath} style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{configPath}</span>
            ) : null}
            <span style={{ fontSize: "var(--fs-secondary)", fontFamily: "var(--font-mono)", color: "var(--c-text-5)", background: "var(--c-bg-3)", padding: "2px 6px", borderRadius: "var(--r-btn)" }}>ESC</span>
            <button onClick={onClose} className="hover-primary" style={{ padding: "6px 18px", borderRadius: "var(--r-btn)", border: "none", background: "var(--c-btn-primary-bg)", color: "var(--c-btn-primary-text)", fontSize: "var(--fs-body)", fontWeight: 500, cursor: "pointer", transition: "opacity var(--duration-fast) var(--ease-smooth), transform var(--duration-fast) var(--ease-out-expo)" }}>
              {t("common.done")}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
