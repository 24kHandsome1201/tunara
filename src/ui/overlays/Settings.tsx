import { useCallback, useEffect, useRef, useState } from "react";
import { type ThemeType, type TerminalThemeName } from "../types";
import { useUIStore, type CursorStyle, type ExternalEditor, EXTERNAL_EDITORS, EDITOR_LABELS } from "@/state/ui";
import { isDarkTheme } from "@/styles/terminalTheme";
import { invoke } from "@tauri-apps/api/core";
import { AgentBadge } from "@/ui/agents";
import { AGENT_REGISTRY } from "@/modules/agent/registry";
import { CloseIcon, RefreshIcon } from "../shared";

interface SettingsProps {
  onClose: () => void;
}

type ResolveSource = "userOverride" | "loginShellPath" | "systemPath" | "notFound";
interface ResolvedCommand {
  name: string;
  path: string | null;
  source: ResolveSource;
}

type SettingsTab = "外观" | "CLI";

const TABS: SettingsTab[] = ["外观", "CLI"];

function ThemeCard({ label, themeType, selected, onClick }: { label: string; themeType: ThemeType; selected: boolean; onClick: () => void }) {
  const isDark = themeType === "dark";
  const isSystem = themeType === "system";
  const previewBg = isDark ? "#1a1a1f" : isSystem ? "linear-gradient(135deg, #fbfbfc 50%, #1a1a1f 50%)" : "#fbfbfc";
  const sidebarBg = isDark ? "rgba(255,255,255,0.08)" : isSystem ? "rgba(194,104,60,0.16)" : "#f0eff2";
  const contentBg = isDark ? "rgba(255,255,255,0.12)" : isSystem ? "rgba(255,255,255,0.72)" : "#ffffff";
  return (
    <button onClick={onClick} style={{ flex: 1, border: selected ? "2px solid var(--c-accent)" : "1px solid var(--c-border-2)", borderRadius: "var(--r-card)", padding: 0, cursor: "pointer", background: "transparent", overflow: "hidden", textAlign: "left" }}>
      <div style={{ height: 62, background: previewBg, borderBottom: "1px solid var(--c-border-2)", padding: 7, display: "flex", gap: 6 }}>
        <div style={{ width: 30, borderRadius: 5, background: sidebarBg, boxShadow: "inset -1px 0 color-mix(in srgb, var(--c-border-2) 80%, transparent)", display: "flex", flexDirection: "column", padding: "6px 3px", gap: 3 }}>
          <div style={{ height: 2, borderRadius: 1, background: isDark ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.08)" }} />
          <div style={{ height: 2, width: "70%", borderRadius: 1, background: isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.05)" }} />
          <div style={{ height: 2, width: "85%", borderRadius: 1, background: isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.05)" }} />
        </div>
        <div style={{ flex: 1, minWidth: 0, borderRadius: 5, background: contentBg, position: "relative", overflow: "hidden", boxShadow: "inset 0 0 0 1px color-mix(in srgb, var(--c-border-2) 64%, transparent)" }}>
          <div style={{ position: "absolute", left: 6, top: 7, display: "flex", alignItems: "center", gap: 3 }}>
            <div style={{ width: 3, height: 3, borderRadius: "50%", background: "var(--c-accent)", opacity: 0.7 }} />
            <div style={{ height: 2, width: 20, borderRadius: 1, background: "var(--c-accent)", opacity: isDark ? 0.72 : 0.62 }} />
          </div>
          <div style={{ position: "absolute", left: 6, right: 6, top: 18, height: 2, borderRadius: 1, background: isDark ? "rgba(255,255,255,0.12)" : "rgba(20,20,24,0.06)" }} />
          <div style={{ position: "absolute", left: 6, right: "38%", bottom: 8, height: 7, borderRadius: 4, background: isDark ? "rgba(255,255,255,0.14)" : "rgba(20,20,24,0.08)" }} />
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
    <button onClick={onClick} title={label} style={{ width: 24, height: 24, borderRadius: "50%", border: selected ? `1px solid ${color}` : "1px solid transparent", padding: 3, background: selected ? "var(--c-bg-3)" : "transparent", cursor: "pointer", flexShrink: 0, boxShadow: "none" }}>
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
];

function CursorStylePicker({ value, onChange }: { value: CursorStyle; onChange: (v: CursorStyle) => void }) {
  const options: { id: CursorStyle; label: string }[] = [
    { id: "bar", label: "竖条" },
    { id: "block", label: "方块" },
    { id: "underline", label: "下划线" },
  ];
  return (
    <div style={{ display: "flex", background: "var(--c-bg-3)", borderRadius: "var(--r-btn)", padding: 2, gap: 0 }}>
      {options.map((opt) => (
        <button
          key={opt.id} onClick={() => onChange(opt.id)}
          style={{ flex: 1, padding: "5px 12px", border: "none", borderRadius: opt.id === value ? "var(--r-btn)" : 0, background: opt.id === value ? "var(--c-bg-white)" : "transparent", color: opt.id === value ? "var(--c-text-primary)" : "var(--c-text-4)", fontSize: "var(--fs-body)", fontWeight: opt.id === value ? 600 : 400, cursor: "pointer", boxShadow: opt.id === value ? "var(--shadow-card)" : "none", transition: "all var(--duration-fast) ease" }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

const SECTION_LABEL: React.CSSProperties = { fontSize: "var(--fs-body)", fontWeight: 600, color: "var(--c-text-3)", marginBottom: 10 };

const CLI_LIST = AGENT_REGISTRY.map(({ code, name }) => ({ code, name }));

const SOURCE_LABELS: Record<ResolveSource, string> = {
  userOverride: "自定义",
  loginShellPath: "登录 Shell",
  systemPath: "系统 PATH",
  notFound: "未找到",
};

export function Settings({ onClose }: SettingsProps) {
  const theme = useUIStore((s) => s.theme);
  const accent = useUIStore((s) => s.accent);
  const cursorStyle = useUIStore((s) => s.cursorStyle);
  const cursorBlink = useUIStore((s) => s.cursorBlink);
  const fontSize = useUIStore((s) => s.fontSize);
  const scrollback = useUIStore((s) => s.scrollback);
  const setTheme = useUIStore((s) => s.setTheme);
  const setAccent = useUIStore((s) => s.setAccent);
  const setCursorStyle = useUIStore((s) => s.setCursorStyle);
  const setCursorBlink = useUIStore((s) => s.setCursorBlink);
  const setFontSize = useUIStore((s) => s.setFontSize);
  const setScrollback = useUIStore((s) => s.setScrollback);
  const terminalTheme = useUIStore((s) => s.terminalTheme);
  const setTerminalTheme = useUIStore((s) => s.setTerminalTheme);
  const externalEditor = useUIStore((s) => s.externalEditor);
  const setExternalEditor = useUIStore((s) => s.setExternalEditor);
  const bellNotification = useUIStore((s) => s.bellNotification);
  const setBellNotification = useUIStore((s) => s.setBellNotification);

  const isDark = isDarkTheme(theme);
  const [activeTab, setActiveTab] = useState<SettingsTab>("外观");
  const sheetRef = useRef<HTMLDivElement>(null);
  useEffect(() => { sheetRef.current?.focus(); }, []);
  const [resolvedClis, setResolvedClis] = useState<ResolvedCommand[] | null>(null);
  const [cliError, setCliError] = useState(false);

  const loadCliStatus = useCallback(() => {
    setResolvedClis(null);
    setCliError(false);
    invoke<ResolvedCommand[]>("resolve_all_bins")
      .then((items) => {
        setResolvedClis(items);
        setCliError(false);
      })
      .catch(() => {
        setResolvedClis([]);
        setCliError(true);
      });
  }, []);

  useEffect(() => {
    loadCliStatus();
  }, [loadCliStatus]);

  const resolvedByCode = new Map((resolvedClis ?? []).map((cli) => [cli.name, cli]));
  const installedCliCount = CLI_LIST.filter(({ code }) => !!resolvedByCode.get(code)?.path).length;

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "var(--backdrop-color)", backdropFilter: "var(--backdrop-blur)", zIndex: 200, animation: "fadeIn var(--duration-normal) ease" }} />
      <div
        ref={sheetRef} tabIndex={0}
        onKeyDown={(e: React.KeyboardEvent) => { if (e.key === "Escape") onClose(); }}
        style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)", width: 600, maxWidth: "calc(100vw - 32px)", background: "var(--c-bg-white)", borderRadius: "var(--r-overlay)", boxShadow: "var(--shadow-overlay)", zIndex: 201, animation: "sheetIn var(--duration-normal) ease", overflow: "hidden", display: "flex", flexDirection: "column", maxHeight: "80vh", outline: "none" }}>
        <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid var(--c-border-1)", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <span style={{ fontSize: "var(--fs-title)", fontWeight: 700, color: "var(--c-text-primary)" }}>设置</span>
            <button onClick={onClose} style={{ width: 26, height: 26, border: "none", background: "transparent", cursor: "pointer", color: "var(--c-text-4)", borderRadius: "var(--r-btn)", display: "flex", alignItems: "center", justifyContent: "center" }} className="hover-bg">
              <CloseIcon size={13} strokeWidth={2.2} />
            </button>
          </div>
          <div style={{ display: "inline-flex", background: "var(--c-bg-3)", borderRadius: "var(--r-pill)", padding: 3, gap: 2 }}>
            {TABS.map((tab) => (
              <button key={tab} onClick={() => setActiveTab(tab)} style={{ padding: "4px 12px", borderRadius: "var(--r-pill)", border: "none", background: activeTab === tab ? "var(--c-bg-white)" : "transparent", color: activeTab === tab ? "var(--c-text-primary)" : "var(--c-text-4)", fontSize: "var(--fs-body)", fontWeight: activeTab === tab ? 600 : 400, cursor: "pointer", boxShadow: activeTab === tab ? "var(--shadow-card)" : "none" }}>
                {tab}
              </button>
            ))}
          </div>
        </div>

        <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }} className="no-scrollbar scroll-fade-y">
          {activeTab === "外观" && (
            <div>
              <div style={{ marginBottom: 24 }}>
                <div style={SECTION_LABEL}>主题</div>
                <div style={{ display: "flex", gap: 10 }}>
                  <ThemeCard label="浅色" themeType="light" selected={theme === "light"} onClick={() => setTheme("light")} />
                  <ThemeCard label="深色" themeType="dark" selected={theme === "dark"} onClick={() => setTheme("dark")} />
                  <ThemeCard label="跟随系统" themeType="system" selected={theme === "system"} onClick={() => setTheme("system")} />
                </div>
              </div>
              <div style={{ marginBottom: 24 }}>
                <div style={SECTION_LABEL}>强调色</div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  {ACCENT_COLORS.map((ac) => (
                    <AccentRing key={ac.color} color={ac.color} label={ac.label} selected={accent === ac.color} onClick={() => setAccent(ac.color)} />
                  ))}
                  <span style={{ marginLeft: 8, fontSize: "var(--fs-secondary)", color: "var(--c-text-4)", fontFamily: "var(--font-mono)" }}>
                    {accent} · {ACCENT_COLORS.find((ac) => ac.color === accent)?.label ?? "自定义"}
                  </span>
                </div>
              </div>
              <div style={{ marginBottom: 24 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={SECTION_LABEL}>终端光标样式</div>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", marginBottom: 10 }}>
                    <span style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-4)" }}>闪烁</span>
                    <button
                      onClick={() => setCursorBlink(!cursorBlink)}
                      style={{
                        width: 36, height: 20, borderRadius: 10, border: "none", padding: 2, cursor: "pointer",
                        background: cursorBlink ? "var(--c-accent)" : "var(--c-bg-3)",
                        transition: "background var(--duration-fast) ease",
                        display: "flex", alignItems: "center",
                      }}
                    >
                      <div style={{
                        width: 16, height: 16, borderRadius: "50%", background: "var(--c-bg-white)",
                        boxShadow: "var(--shadow-card)",
                        transform: cursorBlink ? "translateX(16px)" : "translateX(0)",
                        transition: "transform var(--duration-fast) ease",
                      }} />
                    </button>
                  </label>
                </div>
                <CursorStylePicker value={cursorStyle} onChange={setCursorStyle} />
              </div>
              <div style={{ marginBottom: 24 }}>
                <div style={SECTION_LABEL}>字号</div>
                <div style={{ display: "inline-flex", alignItems: "center", border: "1px solid var(--c-border-2)", borderRadius: "var(--r-btn)", overflow: "hidden" }}>
                  <button onClick={() => setFontSize(Math.max(10, fontSize - 1))} className="hover-bg" style={{ width: 32, height: 30, border: "none", borderRight: "1px solid var(--c-border-2)", background: "var(--c-bg-white)", color: "var(--c-text-2)", fontSize: 15, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>−</button>
                  <span style={{ minWidth: 48, textAlign: "center", fontSize: "var(--fs-body)", fontFamily: "var(--font-mono)", color: "var(--c-text-primary)", padding: "0 4px" }}>{fontSize}px</span>
                  <button onClick={() => setFontSize(Math.min(22, fontSize + 1))} className="hover-bg" style={{ width: 32, height: 30, border: "none", borderLeft: "1px solid var(--c-border-2)", background: "var(--c-bg-white)", color: "var(--c-text-2)", fontSize: 15, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
                </div>
              </div>
              <div style={{ marginBottom: 24 }}>
                <div style={SECTION_LABEL}>回滚行数</div>
                <div style={{ display: "inline-flex", alignItems: "center", border: "1px solid var(--c-border-2)", borderRadius: "var(--r-btn)", overflow: "hidden" }}>
                  <button onClick={() => setScrollback(Math.max(1000, scrollback - 1000))} className="hover-bg" style={{ width: 32, height: 30, border: "none", borderRight: "1px solid var(--c-border-2)", background: "var(--c-bg-white)", color: "var(--c-text-2)", fontSize: 15, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>−</button>
                  <span style={{ minWidth: 64, textAlign: "center", fontSize: "var(--fs-body)", fontFamily: "var(--font-mono)", color: "var(--c-text-primary)", padding: "0 4px" }}>{scrollback}</span>
                  <button onClick={() => setScrollback(Math.min(50000, scrollback + 1000))} className="hover-bg" style={{ width: 32, height: 30, border: "none", borderLeft: "1px solid var(--c-border-2)", background: "var(--c-bg-white)", color: "var(--c-text-2)", fontSize: 15, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>+</button>
                </div>
              </div>
              <div style={{ marginBottom: 24 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div style={SECTION_LABEL}>完成通知</div>
                  <button
                    onClick={() => setBellNotification(!bellNotification)}
                    style={{
                      width: 36, height: 20, borderRadius: 10, border: "none", padding: 2, cursor: "pointer",
                      background: bellNotification ? "var(--c-accent)" : "var(--c-bg-3)",
                      transition: "background var(--duration-fast) ease",
                      display: "flex", alignItems: "center", marginBottom: 10,
                    }}
                  >
                    <div style={{
                      width: 16, height: 16, borderRadius: "50%", background: "var(--c-bg-white)",
                      boxShadow: "var(--shadow-card)",
                      transform: bellNotification ? "translateX(16px)" : "translateX(0)",
                      transition: "transform var(--duration-fast) ease",
                    }} />
                  </button>
                </div>
                <div style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-4)", marginTop: -6 }}>窗口不在前台时，终端 bell 或 Agent 完成将触发 Dock 弹跳</div>
              </div>
              <div>
                <div style={SECTION_LABEL}>终端配色</div>
                <div style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-4)", marginBottom: 8, marginTop: -4 }}>仅影响终端区域，不改变界面主题</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(118px, 1fr))", gap: 8 }}>
                  {([
                    { id: "default" as TerminalThemeName, label: "默认", bg: isDark ? "#18181b" : "#ffffff", fg: isDark ? "#e4e4e7" : "#27272a" },
                    { id: "github-light" as TerminalThemeName, label: "GitHub", bg: "#ffffff", fg: "#24292f" },
                    { id: "rose-pine-dawn" as TerminalThemeName, label: "Dawn", bg: "#faf4ed", fg: "#575279" },
                    { id: "catppuccin" as TerminalThemeName, label: "Catppuccin", bg: "#1e1e2e", fg: "#cdd6f4" },
                    { id: "tokyo-night" as TerminalThemeName, label: "Tokyo Night", bg: "#1a1b26", fg: "#c0caf5" },
                    { id: "one-dark" as TerminalThemeName, label: "One Dark", bg: "#282c34", fg: "#abb2bf" },
                    { id: "solarized" as TerminalThemeName, label: "Solarized", bg: "#002b36", fg: "#839496" },
                  ]).map((t) => (
                    <button
                      key={t.id}
                      onClick={() => setTerminalTheme(t.id)}
                      style={{
                        width: "100%",
                        border: terminalTheme === t.id ? "2px solid var(--c-accent)" : "1px solid var(--c-border-2)",
                        borderRadius: "var(--r-card)",
                        padding: 0,
                        cursor: "pointer",
                        background: "transparent",
                        overflow: "hidden",
                        textAlign: "left",
                      }}
                    >
                      <div style={{ height: 40, background: t.bg, display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 8px", gap: 2.5 }}>
                        {[{ w: 18, o: 0.35 }, { w: 45, o: 0.6 }, { w: 60, o: 0.45 }, { w: 35, o: 0.5 }, { w: 25, o: 0.3 }].map((line) => (
                          <div key={`${line.w}-${line.o}`} style={{ height: 2.5, width: `${line.w}%`, borderRadius: 1, background: t.fg, opacity: line.o }} />
                        ))}
                      </div>
                      <div style={{ padding: "4px 8px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-primary)", fontWeight: terminalTheme === t.id ? 600 : 400 }}>{t.label}</span>
                        {terminalTheme === t.id && <div style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--c-accent)" }} />}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
              <div style={{ marginTop: 24 }}>
                <div style={SECTION_LABEL}>外部编辑器</div>
                <div style={{ display: "flex", background: "var(--c-bg-3)", borderRadius: "var(--r-btn)", padding: 2, gap: 0 }}>
                  {EXTERNAL_EDITORS.map((ed: ExternalEditor) => (
                    <button
                      key={ed}
                      onClick={() => setExternalEditor(ed)}
                      style={{ flex: 1, padding: "5px 12px", border: "none", borderRadius: ed === externalEditor ? "var(--r-btn)" : 0, background: ed === externalEditor ? "var(--c-bg-white)" : "transparent", color: ed === externalEditor ? "var(--c-text-primary)" : "var(--c-text-4)", fontSize: "var(--fs-body)", fontWeight: ed === externalEditor ? 600 : 400, cursor: "pointer", boxShadow: ed === externalEditor ? "var(--shadow-card)" : "none", transition: "all var(--duration-fast) ease" }}
                    >
                      {EDITOR_LABELS[ed]}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeTab === "CLI" && (
            <div style={{ color: "var(--c-text-4)", fontSize: "var(--fs-body)" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 12 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ ...SECTION_LABEL, marginBottom: 4 }}>CLI 路径</div>
                  <div style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)" }}>
                    {resolvedClis === null ? "正在检测当前应用 PATH" : `已找到 ${installedCliCount}/${CLI_LIST.length}`}
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
                  重新检测
                </button>
              </div>
              {resolvedClis === null && (
                <div style={{ fontSize: "var(--fs-body)", color: "var(--c-text-5)" }}>检测中…</div>
              )}
              {cliError && (
                <div style={{ fontSize: "var(--fs-body)", color: "var(--c-error)", marginBottom: 10 }}>
                  CLI 路径检测失败
                </div>
              )}
              {resolvedClis !== null && (
                <div style={{ display: "flex", flexDirection: "column" }}>
                  {CLI_LIST.map(({ code, name }) => {
                    const cli = resolvedByCode.get(code);
                    const installed = !!cli?.path;
                    const source = cli?.source ?? "notFound";
                    return (
                      <div key={code} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--c-border-1)" }}>
                        <AgentBadge agent={code} size={28} disabled={!installed} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: "var(--fs-body)", fontWeight: 600, color: "var(--c-text-2)" }}>{name}</div>
                          <div style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-4)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 1 }}>
                            {installed ? cli?.path : "未在当前应用 PATH 中找到"}
                          </div>
                        </div>
                        <span style={{ fontSize: "var(--fs-meta)", color: installed ? "var(--c-success)" : "var(--c-text-5)", fontWeight: 600, flexShrink: 0 }}>
                          {installed ? SOURCE_LABELS[source] : "未找到"}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ borderTop: "1px solid var(--c-border-1)", padding: "12px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          {activeTab === "外观" ? (
            <button
              onClick={() => useUIStore.getState().resetAppearance()}
              style={{ padding: "6px 14px", borderRadius: "var(--r-btn)", border: "1px solid var(--c-border-2)", background: "transparent", color: "var(--c-text-4)", fontSize: "var(--fs-secondary)", cursor: "pointer" }}
              className="hover-bg"
            >
              恢复默认
            </button>
          ) : <span />}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: "var(--fs-secondary)", fontFamily: "var(--font-mono)", color: "var(--c-text-5)", background: "var(--c-bg-3)", padding: "2px 6px", borderRadius: "var(--r-btn)" }}>ESC</span>
            <button onClick={onClose} style={{ padding: "6px 18px", borderRadius: "var(--r-btn)", border: "none", background: "var(--c-btn-primary-bg)", color: "var(--c-btn-primary-text)", fontSize: "var(--fs-body)", fontWeight: 500, cursor: "pointer" }}>
              完成
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
