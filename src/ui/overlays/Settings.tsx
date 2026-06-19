// overlays/Settings — 设置弹层（600px）
// 外观（主题/强调色/光标）、字体（字号）均接入 ui store 并实时生效。

import { useEffect, useRef, useState } from "react";
import { type ThemeType } from "../types";
import { useUIStore, type CursorStyle } from "@/state/ui";
import { getMaxConcurrent, resolveAllBins, preflightAgent, type ResolvedCommand, type Preflight } from "@/modules/agent/agent-bridge";

interface SettingsProps {
  onClose: () => void;
}

type SettingsTab = "外观" | "字体" | "Agents" | "快捷键";

const TABS: SettingsTab[] = ["外观", "字体", "Agents", "快捷键"];

function ThemeCard({ label, themeType, selected, onClick }: { label: string; themeType: ThemeType; selected: boolean; onClick: () => void }) {
  const isDark = themeType === "dark";
  const isSystem = themeType === "system";
  return (
    <button onClick={onClick} style={{ flex: 1, border: selected ? "2px solid var(--c-accent)" : "1px solid var(--c-border-2)", borderRadius: "var(--r-card)", padding: 0, cursor: "pointer", background: "transparent", overflow: "hidden", textAlign: "left" }}>
      <div style={{ height: 60, background: isDark ? "#1a1a1f" : isSystem ? "linear-gradient(135deg, #fff 50%, #1a1a1f 50%)" : "#fbfbfc", borderBottom: "1px solid var(--c-border-2)", display: "flex", flexDirection: "column" }}>
        <div style={{ height: 14, background: isDark ? "#27272a" : "#f7f7f8", borderBottom: `1px solid ${isDark ? "#3f3f46" : "#ededf0"}`, display: "flex", alignItems: "center", paddingLeft: 6, gap: 3 }}>
          {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
            <div key={c} style={{ width: 4, height: 4, borderRadius: "50%", background: c }} />
          ))}
        </div>
        <div style={{ flex: 1, display: "flex" }}>
          <div style={{ width: 30, background: isDark ? "#2a2a30" : "#f0eff2", borderRight: `1px solid ${isDark ? "#3f3f46" : "#ededf0"}` }} />
          <div style={{ flex: 1, padding: "4px 6px", display: "flex", flexDirection: "column", gap: 2 }}>
            {[8, 6, 7].map((w, i) => (
              <div key={i} style={{ height: 2, width: `${w * 8}%`, borderRadius: 1, background: isDark ? "#3f3f46" : "#e0e0e5" }} />
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
          key={opt.id}
          onClick={() => onChange(opt.id)}
          style={{ flex: 1, padding: "5px 12px", border: "none", borderRadius: opt.id === value ? "var(--r-btn)" : 0, background: opt.id === value ? "var(--c-bg-white)" : "transparent", color: opt.id === value ? "var(--c-text-primary)" : "var(--c-text-4)", fontSize: "var(--fs-body)", fontWeight: opt.id === value ? 600 : 400, cursor: "pointer", boxShadow: opt.id === value ? "var(--shadow-card)" : "none", transition: "all 0.15s ease" }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

const SECTION_LABEL: React.CSSProperties = { fontSize: "var(--fs-body)", fontWeight: 600, color: "var(--c-text-3)", marginBottom: 10 };

export function Settings({ onClose }: SettingsProps) {
  const theme = useUIStore((s) => s.theme);
  const accent = useUIStore((s) => s.accent);
  const cursorStyle = useUIStore((s) => s.cursorStyle);
  const fontSize = useUIStore((s) => s.fontSize);
  const setTheme = useUIStore((s) => s.setTheme);
  const setAccent = useUIStore((s) => s.setAccent);
  const setCursorStyle = useUIStore((s) => s.setCursorStyle);
  const setFontSize = useUIStore((s) => s.setFontSize);

  const [activeTab, setActiveTab] = useState<SettingsTab>("外观");
  const sheetRef = useRef<HTMLDivElement>(null);
  useEffect(() => { sheetRef.current?.focus(); }, []);
  const [maxConcurrent, setMaxConcurrent] = useState(4);
  const [resolvedClis, setResolvedClis] = useState<ResolvedCommand[]>([]);
  const [preflights, setPreflights] = useState<Record<string, Preflight>>({});

  useEffect(() => {
    getMaxConcurrent().then(setMaxConcurrent).catch(() => {});
    resolveAllBins().then((bins) => {
      setResolvedClis(bins);
      for (const bin of bins) {
        if (bin.path) {
          preflightAgent(bin.name).then((pf) =>
            setPreflights((prev) => ({ ...prev, [bin.name]: pf })),
          ).catch(() => {});
        }
      }
    }).catch(() => {});
  }, []);

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(20,20,28,0.34)", backdropFilter: "blur(4px)", zIndex: 200, animation: "fadeIn 0.2s ease" }} />
      <div
        ref={sheetRef}
        tabIndex={0}
        onKeyDown={(e: React.KeyboardEvent) => { if (e.key === "Escape") onClose(); }}
        style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%, -50%)", width: 600, background: "var(--c-bg-white)", borderRadius: "var(--r-overlay)", boxShadow: "var(--shadow-overlay)", zIndex: 201, animation: "sheetIn 0.24s ease", overflow: "hidden", display: "flex", flexDirection: "column", maxHeight: "80vh", outline: "none" }}>
        {/* 头部 */}
        <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid var(--c-border-1)", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <span style={{ fontSize: "var(--fs-title)", fontWeight: 700, color: "var(--c-text-primary)" }}>设置</span>
            <button
              onClick={onClose}
              style={{ width: 26, height: 26, border: "none", background: "transparent", cursor: "pointer", fontSize: 16, color: "var(--c-text-4)", borderRadius: "var(--r-btn)", display: "flex", alignItems: "center", justifyContent: "center" }}
              className="hover-bg"
            >
              ✕
            </button>
          </div>
          <div style={{ display: "inline-flex", background: "var(--c-bg-3)", borderRadius: "var(--r-pill)", padding: 3, gap: 2 }}>
            {TABS.map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{ padding: "4px 12px", borderRadius: "var(--r-pill)", border: "none", background: activeTab === tab ? "var(--c-bg-white)" : "transparent", color: activeTab === tab ? "var(--c-text-primary)" : "var(--c-text-4)", fontSize: "var(--fs-body)", fontWeight: activeTab === tab ? 600 : 400, cursor: "pointer", boxShadow: activeTab === tab ? "var(--shadow-card)" : "none" }}
              >
                {tab}
              </button>
            ))}
          </div>
        </div>

        {/* 内容区 */}
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

              <div>
                <div style={SECTION_LABEL}>终端光标样式</div>
                <CursorStylePicker value={cursorStyle} onChange={setCursorStyle} />
              </div>
            </div>
          )}

          {activeTab === "字体" && (
            <div>
              <div style={{ marginBottom: 20 }}>
                <div style={SECTION_LABEL}>终端字体</div>
                <div style={{ padding: "8px 12px", border: "1px solid var(--c-border-2)", borderRadius: "var(--r-input)", background: "var(--c-bg-white)", fontFamily: "var(--font-mono)", fontSize: "var(--fs-body)", color: "var(--c-text-primary)" }}>
                  JetBrains Mono
                </div>
              </div>
              <div>
                <div style={SECTION_LABEL}>字号</div>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <button
                    onClick={() => setFontSize(Math.max(10, fontSize - 1))}
                    style={{ width: 30, height: 30, borderRadius: "var(--r-btn)", border: "1px solid var(--c-border-2)", background: "var(--c-bg-white)", color: "var(--c-text-2)", fontSize: 16, cursor: "pointer" }}
                  >
                    −
                  </button>
                  <span style={{ minWidth: 48, textAlign: "center", fontSize: "var(--fs-body)", fontFamily: "var(--font-mono)", color: "var(--c-text-primary)" }}>{fontSize}px</span>
                  <button
                    onClick={() => setFontSize(Math.min(22, fontSize + 1))}
                    style={{ width: 30, height: 30, borderRadius: "var(--r-btn)", border: "1px solid var(--c-border-2)", background: "var(--c-bg-white)", color: "var(--c-text-2)", fontSize: 16, cursor: "pointer" }}
                  >
                    +
                  </button>
                </div>
              </div>
            </div>
          )}

          {activeTab === "Agents" && (
            <div style={{ color: "var(--c-text-4)", fontSize: "var(--fs-body)" }}>
              {[{ code: "CC", name: "Claude Code" }, { code: "CX", name: "Codex" }, { code: "AM", name: "Amp" }, { code: "GM", name: "Gemini" }, { code: "CP", name: "Copilot" }, { code: "CR", name: "Cursor" }, { code: "DR", name: "Droid" }, { code: "OC", name: "OpenCode" }, { code: "PI", name: "Pi" }, { code: "AG", name: "Auggie" }, { code: "DV", name: "Devin" }].map(({ code, name }) => {
                const cli = resolvedClis.find((c) => c.name === code);
                const pf = preflights[code];
                return (
                  <div key={code} style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: "var(--fs-body)", fontWeight: 600, color: "var(--c-text-3)", marginBottom: 4 }}>{name} ({code})</div>
                    <div style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-4)", fontFamily: "var(--font-mono)", marginBottom: 2 }}>
                      {cli?.path
                        ? <>{cli.path} <span style={{ color: "var(--c-success)" }}>✓</span>{pf?.loggedIn ? " 已登录" : pf ? " 未登录" : ""}</>
                        : cli ? "未找到" : "检测中…"}
                    </div>
                    <div style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-4)" }}>并发上限：{maxConcurrent} 个会话</div>
                  </div>
                );
              })}
            </div>
          )}

          {activeTab === "快捷键" && (
            <div>
              {[
                { key: "⌘T", desc: "新建终端" },
                { key: "⌘N", desc: "新建 Agent" },
                { key: "⌘⏎", desc: "创建 Agent（弹层内）" },
                { key: "⌘W", desc: "关闭当前 Tab" },
                { key: "⌘,", desc: "打开设置" },
                { key: "⌘\\", desc: "切换侧边栏" },
              ].map((item) => (
                <div key={item.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid var(--c-border-1)" }}>
                  <span style={{ fontSize: "var(--fs-body)", color: "var(--c-text-2)" }}>{item.desc}</span>
                  <span style={{ fontSize: "var(--fs-body)", fontFamily: "var(--font-mono)", color: "var(--c-text-4)", background: "var(--c-bg-3)", padding: "3px 8px", borderRadius: "var(--r-btn)" }}>{item.key}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 底部 */}
        <div style={{ borderTop: "1px solid var(--c-border-1)", padding: "12px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <span style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-5)" }}>更改即时生效</span>
          <button onClick={onClose} style={{ padding: "7px 20px", borderRadius: "var(--r-btn)", border: "none", background: "var(--c-btn-primary-bg)", color: "var(--c-btn-primary-text)", fontSize: "var(--fs-body)", fontWeight: 500, cursor: "pointer" }}>
            完成
          </button>
        </div>
      </div>
    </>
  );
}
