// overlays/Settings — 设置弹层（600px）
// 含：子标签(外观/字体/Agents/快捷键) / 主题三卡 / 强调色环 / 光标样式分段
// 深色主题本期不实装，仅切换选中态

import { useState } from "react";
import { type ThemeType } from "../types";

interface SettingsProps {
  theme: ThemeType;
  onThemeChange: (t: ThemeType) => void;
  onClose: () => void;
}

type SettingsTab = "外观" | "字体" | "Agents" | "快捷键";
type CursorStyle = "line" | "block" | "underline";

const TABS: SettingsTab[] = ["外观", "字体", "Agents", "快捷键"];

/** 主题迷你预览卡 */
function ThemeCard({
  label,
  themeType,
  selected,
  onClick,
}: {
  label: string;
  themeType: ThemeType;
  selected: boolean;
  onClick: () => void;
}) {
  const isDark = themeType === "dark";
  const isSystem = themeType === "system";

  return (
    <button
      onClick={onClick}
      style={{
        flex: 1,
        border: selected ? "2px solid var(--c-accent)" : "1px solid var(--c-border-2)",
        borderRadius: "var(--r-card)",
        padding: 0,
        cursor: "pointer",
        background: "transparent",
        overflow: "hidden",
        textAlign: "left",
      }}
    >
      {/* 迷你窗口缩略图 */}
      <div
        style={{
          height: 60,
          background: isDark ? "#1a1a1f" : isSystem ? "linear-gradient(135deg, #fff 50%, #1a1a1f 50%)" : "#fbfbfc",
          borderBottom: "1px solid var(--c-border-2)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* 迷你标题栏 */}
        <div
          style={{
            height: 14,
            background: isDark ? "#27272a" : "#f7f7f8",
            borderBottom: `1px solid ${isDark ? "#3f3f46" : "#ededf0"}`,
            display: "flex",
            alignItems: "center",
            paddingLeft: 6,
            gap: 3,
          }}
        >
          {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
            <div
              key={c}
              style={{ width: 4, height: 4, borderRadius: "50%", background: c }}
            />
          ))}
        </div>
        {/* 迷你内容区 */}
        <div style={{ flex: 1, display: "flex" }}>
          <div
            style={{
              width: 30,
              background: isDark ? "#2a2a30" : "#f0eff2",
              borderRight: `1px solid ${isDark ? "#3f3f46" : "#ededf0"}`,
            }}
          />
          <div style={{ flex: 1, padding: "4px 6px", display: "flex", flexDirection: "column", gap: 2 }}>
            {[8, 6, 7].map((w, i) => (
              <div
                key={i}
                style={{
                  height: 2,
                  width: `${w * 8}%`,
                  borderRadius: 1,
                  background: isDark ? "#3f3f46" : "#e0e0e5",
                }}
              />
            ))}
          </div>
        </div>
      </div>

      {/* 标签 + 单选 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "6px 10px",
        }}
      >
        <span
          style={{
            fontSize: "var(--fs-secondary)",
            color: "var(--c-text-primary)",
            fontWeight: selected ? 600 : 400,
          }}
        >
          {label}
        </span>
        <div
          style={{
            width: 14,
            height: 14,
            borderRadius: "50%",
            border: selected
              ? `5px solid var(--c-accent)`
              : "1.5px solid #d4d4d8",
          }}
        />
      </div>
    </button>
  );
}

/** 强调色环 */
function AccentRing({
  color,
  label,
  selected,
}: {
  color: string;
  label: string;
  selected: boolean;
}) {
  return (
    <button
      title={label}
      style={{
        width: 24,
        height: 24,
        borderRadius: "50%",
        border: selected ? `2px solid ${color}` : "none",
        padding: 2,
        background: "transparent",
        cursor: "pointer",
        flexShrink: 0,
        boxShadow: selected ? `0 0 0 1px ${color}` : "none",
      }}
    >
      <div
        style={{
          width: "100%",
          height: "100%",
          borderRadius: "50%",
          background: color,
        }}
      />
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

/** 光标样式分段控件 */
function CursorStylePicker({
  value,
  onChange,
}: {
  value: CursorStyle;
  onChange: (v: CursorStyle) => void;
}) {
  const options: { id: CursorStyle; label: string }[] = [
    { id: "line", label: "竖条" },
    { id: "block", label: "方块" },
    { id: "underline", label: "下划线" },
  ];

  return (
    <div
      style={{
        display: "flex",
        background: "var(--c-bg-3)",
        borderRadius: "var(--r-btn)",
        padding: 2,
        gap: 0,
      }}
    >
      {options.map((opt) => (
        <button
          key={opt.id}
          onClick={() => onChange(opt.id)}
          style={{
            flex: 1,
            padding: "5px 12px",
            border: "none",
            borderRadius: opt.id === value ? "var(--r-btn)" : 0,
            background: opt.id === value ? "var(--c-bg-white)" : "transparent",
            color: opt.id === value ? "var(--c-text-primary)" : "var(--c-text-4)",
            fontSize: "var(--fs-body)",
            fontWeight: opt.id === value ? 600 : 400,
            cursor: "pointer",
            boxShadow: opt.id === value ? "var(--shadow-card)" : "none",
            transition: "all 0.15s ease",
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function Settings({ theme, onThemeChange, onClose }: SettingsProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("外观");
  const [cursorStyle, setCursorStyle] = useState<CursorStyle>("line");
  const [selectedAccent] = useState("#c2683c");

  return (
    <>
      {/* 遮罩 */}
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(20,20,28,0.34)",
          backdropFilter: "blur(4px)",
          zIndex: 200,
          animation: "fadeIn 0.2s ease",
        }}
      />

      {/* Sheet */}
      <div
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 600,
          background: "var(--c-bg-white)",
          borderRadius: "var(--r-overlay)",
          boxShadow: "var(--shadow-overlay)",
          zIndex: 201,
          animation: "sheetIn 0.24s ease",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          maxHeight: "80vh",
        }}
      >
        {/* 头部：标题 + 子标签 + ✕ */}
        <div
          style={{
            padding: "20px 24px 16px",
            borderBottom: "1px solid var(--c-border-1)",
            flexShrink: 0,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 14,
            }}
          >
            <span
              style={{
                fontSize: "var(--fs-title)",
                fontWeight: 700,
                color: "var(--c-text-primary)",
              }}
            >
              设置
            </span>
            <button
              onClick={onClose}
              style={{
                width: 26,
                height: 26,
                border: "none",
                background: "transparent",
                cursor: "pointer",
                fontSize: 16,
                color: "var(--c-text-4)",
                borderRadius: "var(--r-btn)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "var(--c-bg-hover)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLButtonElement).style.background = "transparent";
              }}
            >
              ✕
            </button>
          </div>

          {/* 子标签胶囊 */}
          <div
            style={{
              display: "inline-flex",
              background: "var(--c-bg-3)",
              borderRadius: "var(--r-pill)",
              padding: 3,
              gap: 2,
            }}
          >
            {TABS.map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  padding: "4px 12px",
                  borderRadius: "var(--r-pill)",
                  border: "none",
                  background: activeTab === tab ? "var(--c-bg-white)" : "transparent",
                  color: activeTab === tab ? "var(--c-text-primary)" : "var(--c-text-4)",
                  fontSize: "var(--fs-body)",
                  fontWeight: activeTab === tab ? 600 : 400,
                  cursor: "pointer",
                  boxShadow: activeTab === tab ? "var(--shadow-card)" : "none",
                }}
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
              {/* 主题选择 */}
              <div style={{ marginBottom: 24 }}>
                <div
                  style={{
                    fontSize: "var(--fs-body)",
                    fontWeight: 600,
                    color: "var(--c-text-3)",
                    marginBottom: 10,
                  }}
                >
                  主题
                </div>
                <div style={{ display: "flex", gap: 10 }}>
                  <ThemeCard
                    label="浅色"
                    themeType="light"
                    selected={theme === "light"}
                    onClick={() => onThemeChange("light")}
                  />
                  <ThemeCard
                    label="深色"
                    themeType="dark"
                    selected={theme === "dark"}
                    onClick={() => onThemeChange("dark")}
                  />
                  <ThemeCard
                    label="跟随系统"
                    themeType="system"
                    selected={theme === "system"}
                    onClick={() => onThemeChange("system")}
                  />
                </div>
              </div>

              {/* 强调色 */}
              <div style={{ marginBottom: 24 }}>
                <div
                  style={{
                    fontSize: "var(--fs-body)",
                    fontWeight: 600,
                    color: "var(--c-text-3)",
                    marginBottom: 10,
                  }}
                >
                  强调色
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  {ACCENT_COLORS.map((ac) => (
                    <AccentRing
                      key={ac.color}
                      color={ac.color}
                      label={ac.label}
                      selected={selectedAccent === ac.color}
                    />
                  ))}
                  <span
                    style={{
                      marginLeft: 8,
                      fontSize: "var(--fs-secondary)",
                      color: "var(--c-text-4)",
                      fontFamily: "var(--font-mono)",
                    }}
                  >
                    {ACCENT_COLORS.find((ac) => ac.color === selectedAccent)?.color} ·{" "}
                    {ACCENT_COLORS.find((ac) => ac.color === selectedAccent)?.label}
                  </span>
                </div>
              </div>

              {/* 终端光标样式 */}
              <div>
                <div
                  style={{
                    fontSize: "var(--fs-body)",
                    fontWeight: 600,
                    color: "var(--c-text-3)",
                    marginBottom: 10,
                  }}
                >
                  光标样式
                </div>
                <CursorStylePicker value={cursorStyle} onChange={setCursorStyle} />
              </div>
            </div>
          )}

          {activeTab === "字体" && (
            <div style={{ color: "var(--c-text-4)", fontSize: "var(--fs-body)" }}>
              <div style={{ marginBottom: 16 }}>
                <div
                  style={{
                    fontSize: "var(--fs-body)",
                    fontWeight: 600,
                    color: "var(--c-text-3)",
                    marginBottom: 8,
                  }}
                >
                  终端字体
                </div>
                <div
                  style={{
                    padding: "8px 12px",
                    border: "1px solid var(--c-border-2)",
                    borderRadius: "var(--r-input)",
                    background: "var(--c-bg-white)",
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--fs-body)",
                    color: "var(--c-text-primary)",
                  }}
                >
                  JetBrains Mono
                </div>
              </div>
              <div>
                <div
                  style={{
                    fontSize: "var(--fs-body)",
                    fontWeight: 600,
                    color: "var(--c-text-3)",
                    marginBottom: 8,
                  }}
                >
                  字号
                </div>
                <div
                  style={{
                    padding: "8px 12px",
                    border: "1px solid var(--c-border-2)",
                    borderRadius: "var(--r-input)",
                    background: "var(--c-bg-white)",
                    fontSize: "var(--fs-body)",
                    color: "var(--c-text-primary)",
                  }}
                >
                  13px
                </div>
              </div>
            </div>
          )}

          {activeTab === "Agents" && (
            <div style={{ color: "var(--c-text-4)", fontSize: "var(--fs-body)" }}>
              <div style={{ marginBottom: 16 }}>
                <div
                  style={{
                    fontSize: "var(--fs-body)",
                    fontWeight: 600,
                    color: "var(--c-text-3)",
                    marginBottom: 4,
                  }}
                >
                  Claude Code (CC)
                </div>
                <div style={{ fontSize: "var(--fs-body)", color: "var(--c-text-4)" }}>
                  并发上限：4 个会话
                </div>
              </div>
              <div>
                <div
                  style={{
                    fontSize: "var(--fs-body)",
                    fontWeight: 600,
                    color: "var(--c-text-3)",
                    marginBottom: 4,
                  }}
                >
                  Codex (CX)
                </div>
                <div style={{ fontSize: "var(--fs-body)", color: "var(--c-text-4)" }}>
                  并发上限：4 个会话
                </div>
              </div>
            </div>
          )}

          {activeTab === "快捷键" && (
            <div>
              {[
                { key: "⌘T", desc: "新建终端" },
                { key: "⌘⏎", desc: "创建 Agent（弹层内）" },
                { key: "⌘W", desc: "关闭当前 Tab" },
                { key: "⌘,", desc: "打开设置" },
                { key: "⌘\\", desc: "切换侧边栏" },
              ].map((item) => (
                <div
                  key={item.key}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "8px 0",
                    borderBottom: "1px solid var(--c-border-1)",
                  }}
                >
                  <span style={{ fontSize: "var(--fs-body)", color: "var(--c-text-2)" }}>
                    {item.desc}
                  </span>
                  <span
                    style={{
                      fontSize: "var(--fs-body)",
                      fontFamily: "var(--font-mono)",
                      color: "var(--c-text-4)",
                      background: "var(--c-bg-3)",
                      padding: "3px 8px",
                      borderRadius: "var(--r-btn)",
                    }}
                  >
                    {item.key}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 底部 */}
        <div
          style={{
            borderTop: "1px solid var(--c-border-1)",
            padding: "12px 24px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-5)" }}>
            更改即时生效
          </span>
          <button
            onClick={onClose}
            style={{
              padding: "7px 20px",
              borderRadius: "var(--r-btn)",
              border: "none",
              background: "#27272a",
              color: "#fff",
              fontSize: "var(--fs-body)",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            完成
          </button>
        </div>
      </div>
    </>
  );
}
