import { useEffect, useRef, useState } from "react";
import { type ThemeType, type TerminalThemeName } from "../types";
import { useUIStore, type CursorStyle, type ExternalEditor, EXTERNAL_EDITORS, EDITOR_LABELS } from "@/state/ui";
import { invoke } from "@tauri-apps/api/core";
import { AgentBadge } from "@/ui/agents";

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
  return (
    <button onClick={onClick} style={{ flex: 1, border: selected ? "2px solid var(--c-accent)" : "1px solid var(--c-border-2)", borderRadius: "var(--r-card)", padding: 0, cursor: "pointer", background: "transparent", overflow: "hidden", textAlign: "left" }}>
      <div style={{ height: 56, background: isDark ? "#1a1a1f" : isSystem ? "linear-gradient(135deg, #fff 50%, #1a1a1f 50%)" : "#fbfbfc", borderBottom: "1px solid var(--c-border-2)", display: "flex", flexDirection: "column" }}>
        <div style={{ height: 14, background: isDark ? "#27272a" : "#f7f7f8", borderBottom: `1px solid ${isDark ? "#3f3f46" : "#ededf0"}`, display: "flex", alignItems: "center", paddingLeft: 6, gap: 2.5 }}>
          {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
            <div key={c} style={{ width: 4, height: 4, borderRadius: "50%", background: c }} />
          ))}
        </div>
        <div style={{ flex: 1, display: "flex" }}>
          <div style={{ width: 28, background: isDark ? "#2a2a30" : "#f0eff2", borderRight: `1px solid ${isDark ? "#3f3f46" : "#ededf0"}`, padding: "4px 3px", display: "flex", flexDirection: "column", gap: 2.5 }}>
            {[1, 1, 1].map((_, i) => (
              <div key={i} style={{ height: 2.5, borderRadius: 1.5, background: i === 0 ? "var(--c-accent)" : (isDark ? "#3f3f46" : "#d8d8de"), opacity: i === 0 ? 0.6 : 0.4 }} />
            ))}
          </div>
          <div style={{ flex: 1, padding: "4px 6px", display: "flex", flexDirection: "column", gap: 2.5 }}>
            {[9, 6, 8].map((w, i) => (
              <div key={i} style={{ height: 2, width: `${w * 9}%`, borderRadius: 1, background: isDark ? "#3f3f46" : "#e0e0e5" }} />
            ))}
          </div>
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
    <button onClick={onClick} title={label} style={{ width: 24, height: 24, borderRadius: "50%", border: selected ? `2px solid ${color}` : "none", padding: 2, background: "transparent", cursor: "pointer", flexShrink: 0, boxShadow: selected ? `0 0 0 1px ${color}` : "none" }}>
      <div style={{ width: "100%", height: "100%", borderRadius: "50%", background: color }} />
    </button>
  );
}

const ACCENT_COLORS = [
  { color: "#c2683c", label: "Terracotta" },
  { color: "#2f9e7a", label: "Sage" },
  { color: "#4f6ef0", label: "Indigo" },
  { color: "#e0556b", label: "Rose" },
  { color: "#e2c08d", label: "Sand" },
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

const CLI_LIST = [
  { code: "CC", name: "Claude Code" }, { code: "CX", name: "Codex" }, { code: "AM", name: "Amp" },
  { code: "GM", name: "Gemini" }, { code: "CP", name: "Copilot" }, { code: "CR", name: "Cursor" },
  { code: "DR", name: "Droid" }, { code: "OC", name: "OpenCode" }, { code: "PI", name: "Pi" },
  { code: "AG", name: "Auggie" }, { code: "DV", name: "Devin" },
];

export function Settings({ onClose }: SettingsProps) {
  const theme = useUIStore((s) => s.theme);
  const accent = useUIStore((s) => s.accent);
  const cursorStyle = useUIStore((s) => s.cursorStyle);
  const fontSize = useUIStore((s) => s.fontSize);
  const setTheme = useUIStore((s) => s.setTheme);
  const setAccent = useUIStore((s) => s.setAccent);
  const setCursorStyle = useUIStore((s) => s.setCursorStyle);
  const setFontSize = useUIStore((s) => s.setFontSize);
  const terminalTheme = useUIStore((s) => s.terminalTheme);
  const setTerminalTheme = useUIStore((s) => s.setTerminalTheme);
  const externalEditor = useUIStore((s) => s.externalEditor);
  const setExternalEditor = useUIStore((s) => s.setExternalEditor);

  const [activeTab, setActiveTab] = useState<SettingsTab>("外观");
  const sheetRef = useRef<HTMLDivElement>(null);
  useEffect(() => { sheetRef.current?.focus(); }, []);
  const [resolvedClis, setResolvedClis] = useState<ResolvedCommand[]>([]);

  useEffect(() => {
    invoke<ResolvedCommand[]>("resolve_all_bins").then(setResolvedClis).catch(() => {});
  }, []);

  const installed = CLI_LIST.filter(({ code }) => resolvedClis.find((c) => c.name === code)?.path);

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "var(--backdrop-color)", backdropFilter: "var(--backdrop-blur)", zIndex: 200, animation: "fadeIn var(--duration-normal) ease" }} />
      <div
        ref={sheetRef} tabIndex={0}
        onKeyDown={(e: React.KeyboardEvent) => { if (e.key === "Escape") onClose(); }}
        style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)", width: 600, background: "var(--c-bg-white)", borderRadius: "var(--r-overlay)", boxShadow: "var(--shadow-overlay)", zIndex: 201, animation: "sheetIn var(--duration-normal) ease", overflow: "hidden", display: "flex", flexDirection: "column", maxHeight: "80vh", outline: "none" }}>
        <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid var(--c-border-1)", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <span style={{ fontSize: "var(--fs-title)", fontWeight: 700, color: "var(--c-text-primary)" }}>设置</span>
            <button onClick={onClose} style={{ width: 26, height: 26, border: "none", background: "transparent", cursor: "pointer", color: "var(--c-text-4)", borderRadius: "var(--r-btn)", display: "flex", alignItems: "center", justifyContent: "center" }} className="hover-bg">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
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

        <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }} className="no-scrollbar">
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
                <div style={SECTION_LABEL}>终端光标样式</div>
                <CursorStylePicker value={cursorStyle} onChange={setCursorStyle} />
              </div>
              <div style={{ marginBottom: 24 }}>
                <div style={SECTION_LABEL}>字号</div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <button onClick={() => setFontSize(Math.max(10, fontSize - 1))} style={{ width: 30, height: 30, borderRadius: "var(--r-btn)", border: "1px solid var(--c-border-2)", background: "var(--c-bg-white)", color: "var(--c-text-2)", fontSize: 16, cursor: "pointer" }}>−</button>
                  <span style={{ minWidth: 48, textAlign: "center", fontSize: "var(--fs-body)", fontFamily: "var(--font-mono)", color: "var(--c-text-primary)" }}>{fontSize}px</span>
                  <button onClick={() => setFontSize(Math.min(22, fontSize + 1))} style={{ width: 30, height: 30, borderRadius: "var(--r-btn)", border: "1px solid var(--c-border-2)", background: "var(--c-bg-white)", color: "var(--c-text-2)", fontSize: 16, cursor: "pointer" }}>+</button>
                </div>
              </div>
              <div>
                <div style={SECTION_LABEL}>终端配色</div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {([
                    { id: "default" as TerminalThemeName, label: "默认", bg: "#18181b", fg: "#e4e4e7" },
                    { id: "catppuccin" as TerminalThemeName, label: "Catppuccin", bg: "#1e1e2e", fg: "#cdd6f4" },
                    { id: "tokyo-night" as TerminalThemeName, label: "Tokyo Night", bg: "#1a1b26", fg: "#c0caf5" },
                    { id: "one-dark" as TerminalThemeName, label: "One Dark", bg: "#282c34", fg: "#abb2bf" },
                    { id: "solarized" as TerminalThemeName, label: "Solarized", bg: "#002b36", fg: "#839496" },
                  ]).map((t) => (
                    <button
                      key={t.id}
                      onClick={() => setTerminalTheme(t.id)}
                      style={{
                        width: 100,
                        border: terminalTheme === t.id ? "2px solid var(--c-accent)" : "1px solid var(--c-border-2)",
                        borderRadius: "var(--r-card)",
                        padding: 0,
                        cursor: "pointer",
                        background: "transparent",
                        overflow: "hidden",
                        textAlign: "left",
                      }}
                    >
                      <div style={{ height: 36, background: t.bg, display: "flex", flexDirection: "column", justifyContent: "center", padding: "0 8px", gap: 3 }}>
                        {[{ w: 40, o: 0.3 }, { w: 75, o: 0.6 }, { w: 55, o: 0.4 }, { w: 30, o: 0.25 }].map((line, i) => (
                          <div key={i} style={{ height: 2, width: `${line.w}%`, borderRadius: 1, background: t.fg, opacity: line.o }} />
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
              {resolvedClis.length === 0 && (
                <div style={{ fontSize: "var(--fs-body)", color: "var(--c-text-5)" }}>检测中…</div>
              )}
              {resolvedClis.length > 0 && installed.length === 0 && (
                <div style={{ fontSize: "var(--fs-body)", color: "var(--c-text-5)" }}>未检测到常用终端 CLI</div>
              )}
              {(() => {
                const hasUninstalled = CLI_LIST.some(({ code }) => !resolvedClis.find((c) => c.name === code)?.path);
                return installed.map(({ code, name }) => {
                  const cli = resolvedClis.find((c) => c.name === code);
                  return (
                    <div key={code} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid var(--c-border-1)" }}>
                      <AgentBadge agent={code} size={28} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: "var(--fs-body)", fontWeight: 600, color: "var(--c-text-2)" }}>{name}</div>
                        <div style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-4)", fontFamily: "var(--font-mono)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 1 }}>
                          {cli?.path}
                        </div>
                      </div>
                      {hasUninstalled && (
                        <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-success)", fontWeight: 600 }}>已安装</span>
                      )}
                    </div>
                  );
                });
              })()}
            </div>
          )}
        </div>

        <div style={{ borderTop: "1px solid var(--c-border-1)", padding: "12px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <span style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-5)" }}>更改即时生效</span>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: "var(--fs-secondary)", fontFamily: "var(--font-mono)", color: "var(--c-text-5)", background: "var(--c-bg-3)", padding: "2px 6px", borderRadius: "var(--r-btn)" }}>ESC</span>
            <button onClick={onClose} style={{ padding: "7px 20px", borderRadius: "var(--r-btn)", border: "none", background: "var(--c-btn-primary-bg)", color: "var(--c-btn-primary-text)", fontSize: "var(--fs-body)", fontWeight: 500, cursor: "pointer" }}>
              完成
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
