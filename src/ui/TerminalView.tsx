// TerminalView — 单会话终端（真实 xterm.js + PTY）
// 每个 shell 会话拥有独立、常驻的 PTY/xterm 实例,切 tab 时用 display 隐藏而非销毁,
// 因此后台终端的输出与运行中的进程会保留。读取设置（字号/光标/主题）并实时生效。

import { useEffect, useRef } from "react";
import { type Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openPty, type PtySession } from "@/modules/terminal/lib/pty-bridge";
import { registerCwdHandler } from "@/modules/terminal/lib/osc-handlers";
import { useUIStore } from "@/state/ui";
import { type AgentCode } from "./types";
import { cleanTerminalText } from "@/modules/terminal/lib/terminal-utils";
import { extractCommandFromBuffer, extractCommandFromOsc, getTerminalTailText } from "@/modules/terminal/lib/terminal-buffer-read";
import { isMeaningfulCommand } from "@/modules/terminal/lib/terminal-command";
import { createTerminalInstance } from "@/modules/terminal/lib/terminal-instance";
import { createTerminalOutputBuffer } from "@/modules/terminal/lib/terminal-output-buffer";
import { observeTerminalResize } from "@/modules/terminal/lib/terminal-resize";
import { scanTerminalInputBuffer } from "@/modules/terminal/lib/terminal-input-buffer";
import { detectAgentCommand, detectCodexScreenState, HOOK_READY_AGENTS, parseAgentLifecycleOsc, PROMPT_READY_AGENTS } from "@/modules/terminal/lib/agent-lifecycle";
import { updateTerminalSnapshot, getTerminalSnapshot } from "@/modules/terminal/lib/terminal-snapshot";
import { useSessionsStore } from "@/state/sessions";
import { TerminalSearchBar } from "./TerminalSearchBar";
import { useTerminalSearch } from "./useTerminalSearch";
import { useTerminalRuntimeSync } from "./useTerminalRuntimeSync";

interface TerminalViewProps {
  sessionId: string;
  dir: string;
  active: boolean;
  pendingInput?: string;
  onPendingInputConsumed?: () => void;
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
  const ptyRef = useRef<PtySession | null>(null);
  const initRef = useRef(false);
  const search = useTerminalSearch(termRef);
  const pendingInputRef = useRef(pendingInput);
  pendingInputRef.current = pendingInput;
  const onPendingInputConsumedRef = useRef(onPendingInputConsumed);
  onPendingInputConsumedRef.current = onPendingInputConsumed;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const theme = useUIStore((s) => s.theme);
  const fontSize = useUIStore((s) => s.fontSize);
  const scrollback = useUIStore((s) => s.scrollback);
  const cursorStyle = useUIStore((s) => s.cursorStyle);
  const cursorBlink = useUIStore((s) => s.cursorBlink);
  const terminalTheme = useUIStore((s) => s.terminalTheme);
  const accent = useUIStore((s) => s.accent);

  useTerminalRuntimeSync({
    active,
    termRef,
    fitRef,
    ptyRef,
    fontSize,
    scrollback,
    cursorStyle,
    cursorBlink,
    theme,
    terminalTheme,
    accent,
  });

  useEffect(() => {
    if (initRef.current || !containerRef.current) return;
    initRef.current = true;

    let disposed = false;
    const cleanups: Array<() => void> = [];

    (async () => {
      await document.fonts.load(`${fontSize}px "JetBrains Mono"`);
      if (disposed || !containerRef.current) return;

      const term = createTerminalInstance({
        fontSize,
        scrollback,
        theme,
        terminalTheme,
        accent,
        cursorBlink,
        cursorStyle,
      });
      termRef.current = term;

      const fit = new FitAddon();
      fitRef.current = fit;
      term.loadAddon(fit);
      term.open(containerRef.current);

      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        // WebGL unavailable, canvas fallback
      }

      const serializeAddon = new SerializeAddon();
      term.loadAddon(serializeAddon);

      term.loadAddon(new WebLinksAddon((_event, uri) => { openUrl(uri); }));

      // Fit after WebGL addon loads — the addon replaces the renderer and
      // changes cell metrics; fitting before it loads would measure stale
      // dimensions, causing a cols/rows mismatch with the PTY that shows
      // as garbled output until the next resize.
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      if (disposed || !containerRef.current) return;
      fit.fit();

      const searchAddon = new SearchAddon();
      term.loadAddon(searchAddon);
      const searchResultDisposable = search.registerSearchAddon(searchAddon);
      cleanups.push(() => searchResultDisposable.dispose());

      term.attachCustomKeyEventHandler(search.handleCustomKeyEvent);

      // OSC 133 shell integration:
      // A = prompt start, B = prompt end (input start), C = command execution start, D;N = command end (exit code N)
      let hasAgent = false;
      let currentAgentCode: AgentCode | null = null;
      let agentStartupPending = false;
      let osc133Active = false;
      let promptEndRow = -1;
      let lastExitCode = 0;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      let codexStateTimer: ReturnType<typeof setTimeout> | null = null;
      const getCurrentSession = () =>
        useSessionsStore.getState().sessions.find((s) => s.id === sessionIdRef.current);
      const syncAgentTrackingFromStore = () => {
        const sess = getCurrentSession();
        if (sess?.agent && (!hasAgent || currentAgentCode !== sess.agent)) {
          hasAgent = true;
          currentAgentCode = sess.agent;
          agentStartupPending = sess.agentActivity === "starting";
        }
        return sess;
      };
      const clearAgentTracking = () => {
        hasAgent = false;
        currentAgentCode = null;
        agentStartupPending = false;
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
        if (codexStateTimer) {
          clearTimeout(codexStateTimer);
          codexStateTimer = null;
        }
      };
      const scheduleQuietAgentReady = (delay = 3000) => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          idleTimer = null;
          const s = getCurrentSession();
          if (!s?.agent || s.agentActivity === "idle") return;
          if (currentAgentCode && HOOK_READY_AGENTS.has(currentAgentCode)) {
            agentStartupPending = false;
          }
          useSessionsStore.getState().handleAgentReady(sessionIdRef.current);
        }, delay);
      };

      const markAgentDetected = (agent: AgentCode) => {
        const sess = getCurrentSession();
        hasAgent = true;
        currentAgentCode = agent;
        agentStartupPending = sess?.agent === agent
          ? sess.agentActivity === "starting"
          : HOOK_READY_AGENTS.has(agent);
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
        if (sess?.agent !== agent) {
          useSessionsStore.getState().handleAgentDetected(sessionIdRef.current, agent);
        }
      };

      const applyAgentLifecycleEvent = (data: string) => {
        const payload = parseAgentLifecycleOsc(data);
        if (!payload) return false;
        if (payload.session !== sessionIdRef.current) return true;

        if (payload.event === "start") {
          markAgentDetected(payload.agent);
          return true;
        }

        const current = getCurrentSession();
        if (!current?.agent || current.agent !== payload.agent) return true;

        if (payload.event === "exit") {
          clearAgentTracking();
          useSessionsStore.getState().handleAgentExited(sessionIdRef.current, payload.code ?? lastExitCode);
          if (!document.hasFocus() && useUIStore.getState().bellNotification) {
            getCurrentWindow().requestUserAttention(2);
          }
          return true;
        }

        if (payload.event === "idle" || payload.event === "stop") {
          agentStartupPending = false;
          useSessionsStore.getState().handleAgentReady(sessionIdRef.current);
        }

        return true;
      };

      cleanups.push(
        useSessionsStore.subscribe((state) => {
          const sess = state.sessions.find((s) => s.id === sessionIdRef.current);
          if (sess?.agent && (!hasAgent || currentAgentCode !== sess.agent)) {
            hasAgent = true;
            currentAgentCode = sess.agent;
            agentStartupPending = sess.agentActivity === "starting";
          } else if (!sess?.agent && hasAgent) {
            clearAgentTracking();
          }
        }),
      );

      cleanups.push(
        registerCwdHandler(term, (cwd) => {
          useSessionsStore.getState().handleCwdChange(sessionIdRef.current, cwd);
        }),
      );
      const titleDisposable = term.onTitleChange((title) => {
        const clean = cleanTerminalText(title);
        if (clean) useSessionsStore.getState().handleShellTitle(sessionIdRef.current, clean);
      });
      cleanups.push(() => titleDisposable.dispose());

      let codexDataBurstCount = 0;

      const scheduleCodexStateCheck = () => {
        codexDataBurstCount += 1;
        const store = useSessionsStore.getState();
        const sess = getCurrentSession();
        if (sess?.agent && sess.agentActivity !== "running" && codexDataBurstCount >= 3) {
          store.handleAgentBusy(sessionIdRef.current);
        }

        if (codexStateTimer) clearTimeout(codexStateTimer);
        codexStateTimer = setTimeout(() => {
          codexStateTimer = null;
          codexDataBurstCount = 0;
          if (!hasAgent || currentAgentCode !== "CX") return;
          const s = getCurrentSession();
          if (!s?.agent) return;

          const tail = getTerminalTailText(term);
          const screenState = detectCodexScreenState(tail);

          if (screenState === "ready" && s.agentActivity !== "idle") {
            store.handleAgentReady(sessionIdRef.current);
          }
        }, 500);
      };

      const agentLifecycleDisposable = term.parser.registerOscHandler(777, applyAgentLifecycleEvent);
      cleanups.push(() => agentLifecycleDisposable.dispose());

      const promptDisposable = term.parser.registerOscHandler(133, (data) => {
        const marker = data.charAt(0);
        const trackedSession = syncAgentTrackingFromStore();

        if (hasAgent || trackedSession?.agent) {
          if (marker === "A") {
            const exitCode = lastExitCode;
            clearAgentTracking();

            useSessionsStore.getState().handleAgentExited(sessionIdRef.current, exitCode);
            if (!document.hasFocus() && useUIStore.getState().bellNotification) {
              getCurrentWindow().requestUserAttention(2);
            }
            osc133Active = true;
          } else if (marker === "D") {
            const exitCode = parseInt(data.slice(2), 10) || 0;
            lastExitCode = exitCode;
            clearAgentTracking();
            useSessionsStore.getState().handleAgentExited(sessionIdRef.current, exitCode);
            if (!document.hasFocus() && useUIStore.getState().bellNotification) {
              getCurrentWindow().requestUserAttention(2);
            }
          }
          return true;
        }
        if (marker === "A") {
          osc133Active = true;
        } else if (marker === "B") {
          promptEndRow = term.buffer.active.cursorY + term.buffer.active.baseY;
        } else if (marker === "C") {
          const oscCommand = extractCommandFromOsc(data);
          if (osc133Active && (promptEndRow >= 0 || oscCommand)) {
            const cmd = oscCommand || extractCommandFromBuffer(term, promptEndRow);
            if (cmd) {
              if (isMeaningfulCommand(cmd)) {
                useSessionsStore.getState().handleCommandDetected(sessionIdRef.current, cmd);
              }
              const agent = detectAgentCommand(cmd);
              if (agent) {
                markAgentDetected(agent);
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

      const existingSnapshot = getTerminalSnapshot(sessionIdRef.current);
      if (existingSnapshot) {
        term.write(existingSnapshot.serialized);
        term.write("\r\n\x1b[2m[conduit restored snapshot, new shell started below]\x1b[0m\r\n");
        requestAnimationFrame(() => {
          if (existingSnapshot.viewportY !== undefined) {
            term.scrollToLine(existingSnapshot.viewportY);
          }
        });
      }

      let snapshotTimer: ReturnType<typeof setTimeout> | null = null;
      const scheduleSnapshot = () => {
        if (snapshotTimer) clearTimeout(snapshotTimer);
        snapshotTimer = setTimeout(() => {
          snapshotTimer = null;
          if (!termRef.current) return;
          updateTerminalSnapshot(sessionIdRef.current, {
            serialized: serializeAddon.serialize(),
            viewportY: term.buffer.active.viewportY,
            baseY: term.buffer.active.baseY,
            cols: term.cols,
            rows: term.rows,
            capturedAt: Date.now(),
            truncated: false,
          });
        }, 1000);
      };
      cleanups.push(() => {
        if (snapshotTimer) {
          clearTimeout(snapshotTimer);
          snapshotTimer = null;
        }
      });

      const cwd = dir === "~" ? undefined : dir;
      const outputBuffer = createTerminalOutputBuffer(term);
      cleanups.push(() => outputBuffer.dispose());
      let pty;
      try {
        pty = await openPty(
          sessionIdRef.current,
          term.cols,
          term.rows,
          {
            onData: (bytes) => {
              outputBuffer.push(bytes);
              scheduleSnapshot();
              if (hasAgent && currentAgentCode) {
                if (PROMPT_READY_AGENTS.has(currentAgentCode)) {
                  scheduleCodexStateCheck();
                  return;
                }

                const sess = getCurrentSession();
                if (agentStartupPending && sess?.agentActivity === "idle") {
                  useSessionsStore.getState().handleAgentBusy(sessionIdRef.current);
                }
                if (agentStartupPending || sess?.agentActivity === "running") {
                  scheduleQuietAgentReady();
                }
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
        pty.close().catch(() => {});
        return;
      }
      ptyRef.current = pty;

      const writePty = (data: string) => {
        pty.write(data).catch(() => {
          /* PTY may already be closed by the time xterm flushes input. */
        });
      };
      const resizePty = (cols: number, rows: number) => {
        pty.resize(cols, rows).catch(() => {
          /* Resize can race with process exit or pane teardown. */
        });
      };
      let pendingInputTimer: ReturnType<typeof setTimeout> | null = null;
      cleanups.push(() => {
        if (pendingInputTimer) {
          clearTimeout(pendingInputTimer);
          pendingInputTimer = null;
        }
      });

      if (pendingInputRef.current) {
        const cmd = pendingInputRef.current;
        pendingInputTimer = setTimeout(() => {
          pendingInputTimer = null;
          pty.write(cmd + "\n")
            .then(() => onPendingInputConsumedRef.current?.())
            .catch(() => {});
        }, 300);
      }

      let inputBuffer = "";
      // Fallback keystroke command detection — only used when OSC 133 is not active
      const submitCommandBuffer = (submitted: string) => {
        if (osc133Active) return;
        const trimmed = cleanTerminalText(submitted).trim();
        if (!hasAgent && trimmed && isMeaningfulCommand(trimmed)) {
          useSessionsStore.getState().handleCommandDetected(sessionIdRef.current, trimmed);
        }
        if (!hasAgent) {
          const agent = detectAgentCommand(submitted);
          if (agent) {
            markAgentDetected(agent);
          }
        }
      };
      const dataDisposable = term.onData((data) => {
        writePty(data);
        const submitAgentInput = (submitted: string) => {
          if (!hasAgent) return;
          const trimmed = cleanTerminalText(submitted).trim();
          if (!trimmed) return;
          agentStartupPending = false;
          if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
          }
          const sess = getCurrentSession();
          if (sess?.agent && sess.agentActivity !== "running") {
            useSessionsStore.getState().handleAgentBusy(sessionIdRef.current);
          }
        };
        const result = scanTerminalInputBuffer(inputBuffer, data);
        inputBuffer = result.buffer;
        for (const submitted of result.submissions) {
          submitAgentInput(submitted);
          submitCommandBuffer(submitted);
        }
      });
      cleanups.push(() => dataDisposable.dispose());

      const bellDisposable = term.onBell(() => {
        if (!useUIStore.getState().bellNotification) return;
        if (!document.hasFocus()) {
          getCurrentWindow().requestUserAttention(2);
        }
      });
      cleanups.push(() => bellDisposable.dispose());

      const el = containerRef.current!;
      cleanups.push(observeTerminalResize({
        element: el,
        terminal: term,
        fit,
        resizePty,
        isDisposed: () => disposed,
      }));

      cleanups.push(() => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
        if (codexStateTimer) {
          clearTimeout(codexStateTimer);
          codexStateTimer = null;
        }
      });

      if (active) term.focus();
    })();

    return () => {
      disposed = true;
      cleanups.forEach((fn) => fn());
      if (ptyRef.current) {
        ptyRef.current.close().catch(() => {});
        ptyRef.current = null;
      }
      termRef.current?.dispose();
      termRef.current = null;
    };
    // The PTY cwd is tracked through OSC 7 after spawn. Re-running this effect
    // when `dir` changes would close and recreate the terminal on every `cd`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ flex: 1, position: "relative", minHeight: 0, display: "flex", flexDirection: "column" }}>
      {search.searchOpen && (
        <TerminalSearchBar
          inputRef={search.searchInputRef}
          query={search.searchQuery}
          count={search.searchCount}
          onQueryChange={search.handleSearchChange}
          onNext={search.handleSearchNext}
          onPrev={search.handleSearchPrev}
          onClose={search.closeSearch}
        />
      )}
      <div ref={containerRef} style={{ flex: 1, padding: "var(--sp-2)", minHeight: 0 }} />
    </div>
  );
}
