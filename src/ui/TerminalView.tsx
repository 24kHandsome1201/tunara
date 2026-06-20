// TerminalView — 单会话终端（真实 xterm.js + PTY）
// 每个 shell 会话拥有独立、常驻的 PTY/xterm 实例,切 tab 时用 display 隐藏而非销毁,
// 因此后台终端的输出与运行中的进程会保留。读取设置（字号/光标/主题）并实时生效。

import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import { openPty, type PtySession } from "@/modules/terminal/lib/pty-bridge";
import { registerCwdHandler } from "@/modules/terminal/lib/osc-handlers";
import { useUIStore, type CursorStyle } from "@/state/ui";
import { type AgentCode } from "./types";
import { getTerminalTheme } from "@/styles/terminalTheme";
import { cleanTerminalText } from "@/modules/terminal/lib/terminal-utils";
import { useSessionsStore } from "@/state/sessions";

interface TerminalViewProps {
  sessionId: string;
  dir: string;
  active: boolean;
  pendingInput?: string;
  onPendingInputConsumed?: () => void;
}

const FONT_FAMILY = '"JetBrains Mono", SFMono-Regular, Menlo, monospace';

const HOOKABLE_AGENTS = new Set<AgentCode>(["CC", "CX", "DR", "DV"]);

const NOISE_COMMANDS = new Set([
  "ls", "ll", "la", "l", "dir",
  "cd", "pushd", "popd",
  "pwd", "whoami", "hostname",
  "cat", "head", "tail", "less", "more", "bat",
  "clear", "reset", "cls",
  "echo", "printf", "true", "false",
  "exit", "logout",
  "history", "which", "where", "type", "file",
  "source", ".", "export", "unset", "alias", "unalias",
]);

function isMeaningfulCommand(command: string): boolean {
  const cmd = command.split(/\s+/)[0]?.toLowerCase() ?? "";
  return !NOISE_COMMANDS.has(cmd);
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
  if (cmd === "devin") return "DV";
  return null;
}

export function TerminalView({
  sessionId,
  dir,
  active,
  pendingInput,
  onPendingInputConsumed,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const ptyRef = useRef<PtySession | null>(null);
  const initRef = useRef(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchOpenRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const pendingInputRef = useRef(pendingInput);
  pendingInputRef.current = pendingInput;
  const onPendingInputConsumedRef = useRef(onPendingInputConsumed);
  onPendingInputConsumedRef.current = onPendingInputConsumed;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const theme = useUIStore((s) => s.theme);
  const fontSize = useUIStore((s) => s.fontSize);
  const cursorStyle = useUIStore((s) => s.cursorStyle);
  const terminalTheme = useUIStore((s) => s.terminalTheme);

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
        theme: getTerminalTheme(theme, terminalTheme),
        cursorBlink: true,
        cursorStyle: cursorStyle as CursorStyle,
        cursorInactiveStyle: "outline",
        scrollback: 3_000,
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

      const searchAddon = new SearchAddon();
      term.loadAddon(searchAddon);
      searchAddonRef.current = searchAddon;

      term.attachCustomKeyEventHandler((e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "f" && e.type === "keydown") {
          searchOpenRef.current = true;
          setSearchOpen(true);
          return false;
        }
        if (e.key === "Escape" && e.type === "keydown" && searchOpenRef.current) {
          searchOpenRef.current = false;
          setSearchOpen(false);
          setSearchQuery("");
          searchAddon.clearDecorations();
          return false;
        }
        return true;
      });

      // OSC 133 shell integration:
      // A = prompt start, B = prompt end (input start), C = command execution start, D;N = command end (exit code N)
      let hasAgent = false;
      let currentAgentCode: AgentCode | null = null;
      let resetLastAgent: (() => void) | null = null;
      let osc133Active = false;
      let promptEndRow = -1;
      let lastExitCode = 0;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;

      cleanups.push(
        registerCwdHandler(term, (cwd) => {
          useSessionsStore.getState().handleCwdChange(sessionIdRef.current, cwd);
          // OSC 7 from shell after agent exit → fallback for shells without OSC 133
          if (hasAgent) {
            hasAgent = false;
            resetLastAgent?.();
            useSessionsStore.getState().handleAgentExited(sessionIdRef.current, lastExitCode);
          }
        }),
      );
      const titleDisposable = term.onTitleChange((title) => {
        const clean = cleanTerminalText(title);
        if (clean) useSessionsStore.getState().handleShellTitle(sessionIdRef.current, clean);
      });
      cleanups.push(() => titleDisposable.dispose());

      const extractCommandFromBuffer = (): string => {
        const cursorY = term.buffer.active.cursorY + term.buffer.active.baseY;
        const parts: string[] = [];
        for (let row = promptEndRow; row <= cursorY; row++) {
          const line = term.buffer.active.getLine(row);
          if (line) {
            const text = line.translateToString(true);
            parts.push(text);
          }
        }
        return cleanTerminalText(parts.join(" ")).trim();
      };

      const promptDisposable = term.parser.registerOscHandler(133, (data) => {
        const marker = data.charAt(0);

        if (hasAgent) {
          if (marker === "A") {
            const exitCode = lastExitCode;
            hasAgent = false;
            currentAgentCode = null;
            if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
            resetLastAgent?.();

            useSessionsStore.getState().handleAgentExited(sessionIdRef.current, exitCode);
            osc133Active = true;
          } else if (marker === "D") {
            lastExitCode = parseInt(data.slice(2), 10) || 0;
          }
          return true;
        }
        if (marker === "A") {
          osc133Active = true;
        } else if (marker === "B") {
          promptEndRow = term.buffer.active.cursorY + term.buffer.active.baseY;
        } else if (marker === "C") {
          if (osc133Active && promptEndRow >= 0) {
            const cmd = extractCommandFromBuffer();
            if (cmd) {
              if (isMeaningfulCommand(cmd)) {
                useSessionsStore.getState().handleCommandDetected(sessionIdRef.current, cmd);
              }
              const agent = detectAgentCommand(cmd);
              if (agent) {
                hasAgent = true;
                currentAgentCode = agent;
                useSessionsStore.getState().handleAgentDetected(sessionIdRef.current, agent);
              }
            }
          }
          osc133Active = false;
        } else if (marker === "D") {
          const exitCode = parseInt(data.slice(2), 10) || 0;
          lastExitCode = exitCode;
          useSessionsStore.getState().handleCommandFinished(sessionIdRef.current, exitCode);
        }
        return true;
      });
      cleanups.push(() => promptDisposable.dispose());

      const cwd = dir === "~" ? undefined : dir;
      let pendingData: Uint8Array[] = [];
      let writeRafId = 0;
      cleanups.push(() => { if (writeRafId) cancelAnimationFrame(writeRafId); });
      let pty;
      try {
        pty = await openPty(
          sessionIdRef.current,
          term.cols,
          term.rows,
          {
            onData: (bytes) => {
              pendingData.push(bytes);
              if (!writeRafId) {
                writeRafId = requestAnimationFrame(() => {
                  writeRafId = 0;
                  if (pendingData.length === 1) {
                    term.write(pendingData[0]);
                  } else if (pendingData.length > 1) {
                    let totalLen = 0;
                    for (const d of pendingData) totalLen += d.length;
                    const merged = new Uint8Array(totalLen);
                    let offset = 0;
                    for (const d of pendingData) { merged.set(d, offset); offset += d.length; }
                    term.write(merged);
                  }
                  pendingData = [];
                });
              }
              if (hasAgent && currentAgentCode) {
                if (!HOOKABLE_AGENTS.has(currentAgentCode)) {
                  const sess = useSessionsStore.getState().sessions.find((s) => s.id === sessionIdRef.current);
                  if (sess?.runState === "done") {
                    useSessionsStore.getState().handleAgentResumed(sessionIdRef.current);
                  }
                }
                if (idleTimer) clearTimeout(idleTimer);

                idleTimer = setTimeout(() => {
                  idleTimer = null;
                  const s = useSessionsStore.getState().sessions.find((ss) => ss.id === sessionIdRef.current);

                  if (s?.agent && s.runState === "running") {
                    useSessionsStore.getState().handleAgentTurnDone(sessionIdRef.current);
                  }
                }, 3000);
              }
            },
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

      if (pendingInputRef.current) {
        const cmd = pendingInputRef.current;
        setTimeout(() => {
          pty.write(cmd + "\n");
          onPendingInputConsumedRef.current?.();
        }, 300);
      }

      let inputBuffer = "";
      let lastSubmittedAgent: AgentCode | null = null;
      resetLastAgent = () => { lastSubmittedAgent = null; };
      // Fallback keystroke command detection — only used when OSC 133 is not active
      const submitCommandBuffer = () => {
        if (osc133Active) { inputBuffer = ""; return; }
        const trimmed = cleanTerminalText(inputBuffer).trim();
        if (!hasAgent && trimmed && isMeaningfulCommand(trimmed)) {
          useSessionsStore.getState().handleCommandDetected(sessionIdRef.current, trimmed);
        }
        const agent = detectAgentCommand(inputBuffer);
        if (agent && agent !== lastSubmittedAgent) {
          lastSubmittedAgent = agent;
          hasAgent = true;
          useSessionsStore.getState().handleAgentDetected(sessionIdRef.current, agent);
        }
        inputBuffer = "";
      };
      const dataDisposable = term.onData((data) => {
        pty.write(data);
        if (hasAgent && (data === "\r" || data === "\n")) {
          const sess = useSessionsStore.getState().sessions.find((s) => s.id === sessionIdRef.current);
          if (sess?.agent && sess.runState !== "running") {
            useSessionsStore.getState().handleAgentResumed(sessionIdRef.current);
          }
        }
        {
          for (let i = 0; i < data.length; i += 1) {
            const ch = data[i];
            if (ch === "\x1b") {
              const next = data[i + 1];
              if (next === "]") {
                // OSC sequence: \x1b] ... (terminated by \x07 or \x1b\\)
                i += 2;
                while (i < data.length) {
                  if (data[i] === "\x07") break;
                  if (data[i] === "\x1b" && data[i + 1] === "\\") { i += 1; break; }
                  i += 1;
                }
              } else {
                // CSI / other escape sequences
                while (i + 1 < data.length && !/[A-Za-z~]/.test(data[i + 1])) i += 1;
                if (i + 1 < data.length) i += 1;
              }
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

      cleanups.push(() => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } });

      if (active) term.focus();
    })();

    return () => {
      disposed = true;
      cleanups.forEach((fn) => fn());
      if (ptyRef.current) {
        ptyRef.current.close();
        ptyRef.current = null;
      }
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
    term.options.theme = getTerminalTheme(theme, terminalTheme);
    try {
      fit?.fit();
      if (active && ptyRef.current) ptyRef.current.resize(term.cols, term.rows);
    } catch {
      /* noop */
    }
  }, [fontSize, cursorStyle, theme, terminalTheme, active]);

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    if (!searchAddonRef.current) return;
    if (value) {
      searchAddonRef.current.findNext(value, { regex: false, caseSensitive: false, wholeWord: false });
    } else {
      searchAddonRef.current.clearDecorations();
    }
  }, []);

  const handleSearchNext = useCallback(() => {
    searchAddonRef.current?.findNext(searchQuery, { regex: false, caseSensitive: false, wholeWord: false });
  }, [searchQuery]);

  const handleSearchPrev = useCallback(() => {
    searchAddonRef.current?.findPrevious(searchQuery, { regex: false, caseSensitive: false, wholeWord: false });
  }, [searchQuery]);

  const closeSearch = useCallback(() => {
    searchOpenRef.current = false;
    setSearchOpen(false);
    setSearchQuery("");
    searchAddonRef.current?.clearDecorations();
    termRef.current?.focus();
  }, []);

  return (
    <div style={{ flex: 1, position: "relative", minHeight: 0, display: "flex", flexDirection: "column" }}>
      {searchOpen && (
        <div
          style={{
            position: "absolute",
            top: 6,
            right: 12,
            zIndex: 30,
            background: "var(--c-bg-1)",
            border: "1px solid var(--c-border-2)",
            borderRadius: "var(--r-btn)",
            padding: "4px 8px",
            display: "flex",
            alignItems: "center",
            gap: 4,
            boxShadow: "var(--shadow-card)",
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--c-text-5)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                closeSearch();
              } else if (e.key === "Enter") {
                e.preventDefault();
                if (e.shiftKey) handleSearchPrev();
                else handleSearchNext();
              }
            }}
            autoFocus
            placeholder="搜索…"
            style={{
              border: "none",
              background: "transparent",
              outline: "none",
              fontSize: "var(--fs-body)",
              color: "var(--c-text-primary)",
              fontFamily: "var(--font-ui)",
              width: 200,
            }}
          />
          <button
            onClick={handleSearchPrev}
            title="上一个 ⇧Enter"
            className="hover-bg"
            style={{ width: 22, height: 22, borderRadius: "var(--r-btn)", border: "none", background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="18 15 12 9 6 15" />
            </svg>
          </button>
          <button
            onClick={handleSearchNext}
            title="下一个 Enter"
            className="hover-bg"
            style={{ width: 22, height: 22, borderRadius: "var(--r-btn)", border: "none", background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>
          <button
            onClick={closeSearch}
            title="关闭 Esc"
            className="hover-bg"
            style={{ width: 22, height: 22, borderRadius: "var(--r-btn)", border: "none", background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      )}
      <div ref={containerRef} style={{ flex: 1, padding: "var(--sp-1)", minHeight: 0 }} />
    </div>
  );
}
