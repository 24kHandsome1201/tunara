import React from "react";
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { setLanguage } from "@/modules/i18n";
import { useUIStore } from "@/state/ui";
import { useTheme } from "@/app/useTheme";
import { getTerminalTheme } from "@/styles/terminalTheme";
import { TerminalWallpaper } from "@/ui/TerminalWallpaper";
import { WallpaperSettings } from "@/ui/overlays/settings/TerminalSettings";
import "@/styles/tokens.css";
import "@/styles/globals.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";

const params = new URLSearchParams(window.location.search);
const scene = params.get("scene") ?? "off";
const language = params.get("lang") === "en" ? "en" : "zh-CN";

document.documentElement.lang = language === "zh-CN" ? "zh-CN" : "en";
setLanguage(language);

mockIPC((command) => {
  if (command === "terminal_wallpaper_load") return null;
  if (command === "terminal_wallpaper_clear") return undefined;
  if (command === "save_config" || command === "load_config") return undefined;
  if (command === "os_info") return { os: "linux", arch: "x86_64", version: "6.12" };
  return null;
});

const wallpaperOn = scene !== "off";
const dark = scene === "dark";

useUIStore.setState({
  language,
  theme: dark ? "dark" : "light",
  terminalTheme: dark ? "tokyo-night" : "default",
  terminalWallpaperEnabled: wallpaperOn,
  terminalWallpaperSource: "paper",
  terminalWallpaperBlur: scene === "settings" ? 24 : wallpaperOn ? 16 : 24,
  terminalWallpaperVeil: scene === "settings" ? 78 : wallpaperOn ? (dark ? 62 : 74) : 78,
  sidebarWidth: 220,
  settingsTab: "terminal",
  configLoaded: false,
});

function ThemeBoot() {
  useTheme();
  return null;
}

function VisualReady() {
  React.useEffect(() => {
    let cancelled = false;
    const mark = () => {
      if (!cancelled) document.documentElement.dataset.visualReady = "1";
    };
    const wait = async () => {
      await document.fonts.ready.catch(() => undefined);
      await new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)));
      if (wallpaperOn) {
        for (let attempt = 0; attempt < 40 && !cancelled; attempt += 1) {
          if (document.querySelector('[data-terminal-wallpaper="on"]')) break;
          await new Promise((resolve) => window.setTimeout(resolve, 50));
        }
      }
      if (scene === "settings") {
        const section = document.querySelector("[data-settings-section=\"wallpaper\"]");
        section?.scrollIntoView({ block: "center" });
      }
      await new Promise((resolve) => window.setTimeout(resolve, 80));
      mark();
    };
    void wait();
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}

function FakeTerminal() {
  const theme = useUIStore((s) => s.theme);
  const terminalTheme = useUIStore((s) => s.terminalTheme);
  const accent = useUIStore((s) => s.accent);
  const palette = getTerminalTheme(theme, terminalTheme, accent);
  return (
    <div
      style={{
        position: "relative",
        zIndex: 1,
        height: "100%",
        padding: "18px 22px",
        fontFamily: "var(--font-mono)",
        fontSize: 13,
        lineHeight: 1.55,
        color: palette.foreground,
      }}
    >
      <div style={{ marginBottom: 10 }}>
        <span style={{ color: palette.green }}>tunara</span>
        <span style={{ color: palette.brightBlack }}>@paper</span>
        <span style={{ color: palette.foreground }}> ~ % </span>
        <span>ls -la</span>
      </div>
      <div style={{ color: palette.brightBlack, whiteSpace: "pre" }}>
        {"drwxr-xr-x  12 tunara  staff   384  Aug 17 23:10  src"}
      </div>
      <div style={{ color: palette.brightBlack, whiteSpace: "pre" }}>
        {"-rw-r--r--   1 tunara  staff  2148  Aug 17 22:41  README.md"}
      </div>
      <div style={{ color: palette.brightBlack, whiteSpace: "pre" }}>
        {"-rw-r--r--   1 tunara  staff   812  Aug 17 22:55  package.json"}
      </div>
      <div style={{ marginTop: 16 }}>
        <span style={{ color: palette.green }}>tunara</span>
        <span style={{ color: palette.brightBlack }}>@paper</span>
        <span style={{ color: palette.foreground }}> ~ % </span>
        <span
          style={{
            display: "inline-block",
            width: 8,
            height: 15,
            background: palette.cursor,
            verticalAlign: "text-bottom",
          }}
        />
      </div>
    </div>
  );
}

function WorkspaceChrome({ children }: { children?: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", width: "100vw", height: "100vh", background: "var(--c-bg-white)" }}>
      <header
        style={{
          height: 36,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 12px",
          borderBottom: "1px solid var(--c-border-1)",
          background: "var(--c-bg-1)",
          color: "var(--c-text-3)",
          fontSize: "var(--fs-secondary)",
        }}
      >
        <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#e2c2b4" }} />
        <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#d8cfc4" }} />
        <span style={{ width: 10, height: 10, borderRadius: "50%", background: "#cfc8c0" }} />
        <span style={{ marginLeft: 8, fontWeight: 600, color: "var(--c-text-primary)" }}>主会话</span>
      </header>
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <aside
          style={{
            width: 220,
            flexShrink: 0,
            background: "var(--c-bg-2)",
            borderRight: "1px solid var(--c-border-1)",
            padding: 12,
            color: "var(--c-text-4)",
            fontSize: "var(--fs-secondary)",
          }}
        >
          <div style={{ fontWeight: 700, color: "var(--c-text-primary)", marginBottom: 14 }}>Tunara</div>
          <div
            style={{
              padding: "7px 8px",
              borderRadius: "var(--r-btn)",
              background: "var(--c-bg-hover)",
              color: "var(--c-text-primary)",
            }}
          >
            主会话
          </div>
          <div style={{ padding: "7px 8px", marginTop: 4 }}>日志</div>
        </aside>
        <main
          data-terminal-canvas="workspace"
          style={{
            flex: 1,
            position: "relative",
            minWidth: 0,
            background: "var(--terminal-canvas-bg, var(--c-bg-white))",
            overflow: "hidden",
          }}
        >
          <TerminalWallpaper />
          <FakeTerminal />
        </main>
      </div>
      {children}
    </div>
  );
}

function SettingsOverlay() {
  return (
    <>
      <div
        aria-hidden="true"
        style={{ position: "fixed", inset: 0, background: "var(--backdrop-color)", zIndex: 200 }}
      />
      <div
        role="dialog"
        aria-labelledby="settings-title"
        className="settings-dialog"
        style={{
          position: "fixed",
          top: "50%",
          left: "50%",
          transform: "translate(-50%, -50%)",
          width: 620,
          maxWidth: "calc(100vw - 32px)",
          maxHeight: "min(82dvh, 760px)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          background: "var(--c-bg-white)",
          borderRadius: "var(--r-overlay)",
          boxShadow: "var(--shadow-overlay)",
          zIndex: 201,
        }}
      >
        <div className="settings-dialog-header">
          <div style={{ fontSize: "var(--fs-title)", fontWeight: 700, color: "var(--c-text-primary)", marginBottom: 14 }} id="settings-title">
            设置
          </div>
          <div style={{ display: "flex", gap: 18, borderBottom: "1px solid var(--c-border-1)" }}>
            <span style={{ padding: "5px 0 8px", marginBottom: -1, color: "var(--c-text-4)", fontSize: "var(--fs-body)" }}>外观</span>
            <span style={{ padding: "5px 0 8px", marginBottom: -1, color: "var(--c-text-primary)", fontSize: "var(--fs-body)", fontWeight: 600, borderBottom: "2px solid var(--c-accent)" }}>终端</span>
            <span style={{ padding: "5px 0 8px", marginBottom: -1, color: "var(--c-text-4)", fontSize: "var(--fs-body)" }}>无障碍</span>
          </div>
        </div>
        <div id="settings-tabpanel" className="no-scrollbar" style={{ overflow: "auto" }}>
          <div data-settings-section="wallpaper">
            <WallpaperSettings />
          </div>
        </div>
      </div>
    </>
  );
}

document.body.style.margin = "0";
document.body.style.width = "100vw";
document.body.style.height = "100vh";
document.body.style.overflow = "hidden";

createRoot(document.getElementById("root")!).render(
  <>
    <ThemeBoot />
    <VisualReady />
    <WorkspaceChrome>
      {scene === "settings" ? <SettingsOverlay /> : null}
    </WorkspaceChrome>
  </>,
);
