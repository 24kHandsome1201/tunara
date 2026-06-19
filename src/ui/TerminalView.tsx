// TerminalView — 单会话终端（真实 xterm.js + PTY）
// 每个 shell 会话拥有独立、常驻的 PTY/xterm 实例,切 tab 时用 display 隐藏而非销毁,
// 因此后台终端的输出与运行中的进程会保留。读取设置（字号/光标/主题）并实时生效。

import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { openPty, type PtySession } from "@/modules/terminal/lib/pty-bridge";
import { registerCwdHandler } from "@/modules/terminal/lib/osc-handlers";
import { useUIStore, type CursorStyle } from "@/state/ui";
import { type AgentCode, type ThemeType } from "./types";

interface TerminalViewProps {
  dir: string;
  active: boolean;
  onAgentCommandSubmitted?: (agent: AgentCode) => void;
  onCommandDetected?: (command: string) => void;
  onCwd?: (cwd: string) => void;
  onShellTitle?: (title: string) => void;
}

const FONT_FAMILY = '"JetBrains Mono", SFMono-Regular, Menlo, monospace';

const LIGHT_THEME = {
  background: "#ffffff",
  foreground: "#27272a",
  cursor: "#27272a",
  cursorAccent: "#ffffff",
  selectionBackground: "#c2683c44",
  black: "#27272a", red: "#ef4444", green: "#22c55e", yellow: "#eab308",
  blue: "#3b82f6", magenta: "#a855f7", cyan: "#06b6d4", white: "#e4e4e7",
  brightBlack: "#52525b", brightRed: "#f87171", brightGreen: "#4ade80", brightYellow: "#facc15",
  brightBlue: "#60a5fa", brightMagenta: "#c084fc", brightCyan: "#22d3ee", brightWhite: "#fafafa",
};

const DARK_THEME = {
  background: "#18181b",
  foreground: "#e4e4e7",
  cursor: "#e4e4e7",
  cursorAccent: "#18181b",
  selectionBackground: "#e0907066",
  black: "#3f3f46", red: "#f87171", green: "#4ade80", yellow: "#facc15",
  blue: "#60a5fa", magenta: "#c084fc", cyan: "#22d3ee", white: "#e4e4e7",
  brightBlack: "#52525b", brightRed: "#fca5a5", brightGreen: "#86efac", brightYellow: "#fde047",
  brightBlue: "#93c5fd", brightMagenta: "#d8b4fe", brightCyan: "#67e8f9", brightWhite: "#fafafa",
};

function isDarkTheme(theme: ThemeType): boolean {
  if (theme === "dark") return true;
  if (theme === "system") return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  return false;
}

function detectAgentCommand(commandLine: string): AgentCode | null {
  const cmd = cleanTerminalText(commandLine).trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (cmd === "claude") return "CC";
  if (cmd === "codex") return "CX";
  if (cmd === "amp" || cmd === "ampcode") return "AM";
  if (cmd === "gemini") return "GM";
  if (cmd === "copilot") return "CP";
  if (cmd === "agent") return "CR";
  if (cmd === "droid") return "DR";
  if (cmd === "opencode") return "OC";
  if (cmd === "pi") return "PI";
  if (cmd === "auggie") return "AG";
  return null;
}

export function TerminalView({
  dir,
  active,
  onAgentCommandSubmitted,
  onCommandDetected,
  onCwd,
  onShellTitle,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyRef = useRef<PtySession | null>(null);
  const initRef = useRef(false);
  const onAgentCommandSubmittedRef = useRef(onAgentCommandSubmitted);
  onAgentCommandSubmittedRef.current = onAgentCommandSubmitted;
  const onCommandDetectedRef = useRef(onCommandDetected);
  onCommandDetectedRef.current = onCommandDetected;
  const onCwdRef = useRef<TerminalViewProps["onCwd"]>(undefined);
  const onShellTitleRef = useRef<TerminalViewProps["onShellTitle"]>(undefined);
  onCwdRef.current = onCwd;
  onShellTitleRef.current = onShellTitle;

  const theme = useUIStore((s) => s.theme);
  const fontSize = useUIStore((s) => s.fontSize);
  const cursorStyle = useUIStore((s) => s.cursorStyle);

  useEffect(() => {
    if (initRef.current || !containerRef.current) return;
    initRef.current = true;

    let disposed = false;
    const cleanups: Array<() => void> = [];

    (async () => {
      await document.fonts.load(`${fontSize}px "JetBrains Mono"`);
      if (disposed || !containerRef.current) return;

      const term = new Terminal({
        fontFamily: FONT_FAMILY,
        fontSize,
        lineHeight: 1.05,
        theme: isDarkTheme(theme) ? DARK_THEME : LIGHT_THEME,
        cursorBlink: true,
        cursorStyle: cursorStyle as CursorStyle,
        cursorInactiveStyle: "outline",
        scrollback: 5_000,
        allowProposedApi: true,
      });
      termRef.current = term;

      const fit = new FitAddon();
      fitRef.current = fit;
      term.loadAddon(fit);
      term.open(containerRef.current);
      fit.fit();

      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        // WebGL unavailable, canvas fallback
      }

      cleanups.push(
        registerCwdHandler(term, (cwd) => onCwdRef.current?.(cwd)),
      );
      const titleDisposable = term.onTitleChange((title) => {
        const clean = cleanTerminalText(title);
        if (clean) onShellTitleRef.current?.(clean);
      });
      cleanups.push(() => titleDisposable.dispose());

      const cwd = dir === "~" ? undefined : dir;
      let pty;
      try {
        pty = await openPty(
          term.cols,
          term.rows,
          {
            onData: (bytes) => term.write(bytes),
            onExit: (code) => {
              term.write(`\r\n\x1b[2m[process exited: ${code}]\x1b[0m\r\n`);
              term.options.disableStdin = true;
            },
          },
          cwd,
        );
      } catch (e) {
        term.write(`\r\n\x1b[31m[PTY error: ${e}]\x1b[0m\r\n`);
        return;
      }

      if (disposed) {
        pty.close();
        return;
      }
      ptyRef.current = pty;

      let inputBuffer = "";
      let lastSubmittedAgent: AgentCode | null = null;
      const submitCommandBuffer = () => {
        const trimmed = cleanTerminalText(inputBuffer).trim();
        if (trimmed) {
          onCommandDetectedRef.current?.(trimmed);
        }
        const agent = detectAgentCommand(inputBuffer);
        if (agent && agent !== lastSubmittedAgent) {
          lastSubmittedAgent = agent;
          onAgentCommandSubmittedRef.current?.(agent);
        }
        inputBuffer = "";
      };
      const dataDisposable = term.onData((data) => {
        pty.write(data);
        {
          for (let i = 0; i < data.length; i += 1) {
            const ch = data[i];
            if (ch === "\x1b") {
              // Skip terminal control sequences generated by arrows,
              // bracketed paste delimiters, focus events, etc. They are not
              // user-visible command text and should never become a sidebar
              // title.
              while (i + 1 < data.length && !/[\x07\\A-Za-z~]/.test(data[i + 1])) i += 1;
              if (i + 1 < data.length) i += 1;
            } else if (ch === "\r" || ch === "\n") {
              submitCommandBuffer();
            } else if (ch === "\x7f" || ch === "\b") {
              inputBuffer = inputBuffer.slice(0, -1);
            } else if (ch === "\x03" || ch === "\x15") {
              inputBuffer = "";
            } else if (ch >= " " && ch !== "\x7f") {
              inputBuffer += ch;
            }
          }
        }
      });
      cleanups.push(() => dataDisposable.dispose());

      const el = containerRef.current!;
      let lastW = el.clientWidth;
      let lastH = el.clientHeight;
      let fitTimer: ReturnType<typeof setTimeout> | null = null;
      let resizeTimer: ReturnType<typeof setTimeout> | null = null;

      const observer = new ResizeObserver(() => {
        if (fitTimer) clearTimeout(fitTimer);
        fitTimer = setTimeout(() => {
          fitTimer = null;
          if (disposed) return;
          const w = el.clientWidth;
          const h = el.clientHeight;
          if (w === lastW && h === lastH) return;
          if (w === 0 || h === 0) return;
          lastW = w;
          lastH = h;
          fit.fit();
          if (resizeTimer) clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => {
            resizeTimer = null;
            if (!disposed) pty.resize(term.cols, term.rows);
          }, 250);
        }, 8);
      });
      observer.observe(el);
      cleanups.push(() => {
        observer.disconnect();
        if (fitTimer) clearTimeout(fitTimer);
        if (resizeTimer) clearTimeout(resizeTimer);
      });

      if (active) term.focus();
    })();

    return () => {
      disposed = true;
      cleanups.forEach((fn) => fn());
      ptyRef.current?.close();
      ptyRef.current = null;
      termRef.current?.dispose();
      termRef.current = null;
    };
    // The PTY cwd is tracked through OSC 7 after spawn. Re-running this effect
    // when `dir` changes would close and recreate the terminal on every `cd`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 变为可见时重新 fit + 聚焦（display:none → flex 后容器才有尺寸）
  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    const fit = fitRef.current;
    const pty = ptyRef.current;
    if (!term || !fit) return;
    const t = setTimeout(() => {
      try {
        fit.fit();
        pty?.resize(term.cols, term.rows);
        term.focus();
      } catch {
        /* noop */
      }
    }, 30);
    return () => clearTimeout(t);
  }, [active]);

  // 设置实时生效：字号 / 光标 / 主题
  useEffect(() => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    term.options.cursorStyle = cursorStyle as CursorStyle;
    term.options.theme = isDarkTheme(theme) ? DARK_THEME : LIGHT_THEME;
    try {
      fit?.fit();
      if (active && ptyRef.current) ptyRef.current.resize(term.cols, term.rows);
    } catch {
      /* noop */
    }
  }, [fontSize, cursorStyle, theme, active]);

  return <div ref={containerRef} style={{ flex: 1, padding: "4px 0 0 4px", minHeight: 0 }} />;
}

function cleanTerminalText(text: string): string {
  return text
    // ANSI CSI / OSC fragments should not leak into sidebar titles.
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
