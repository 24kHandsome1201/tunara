import { useEffect, useRef } from "react";
import { type Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import { openPty, type PtySession } from "@/modules/terminal/lib/pty-bridge";
import { registerCwdHandler } from "@/modules/terminal/lib/osc-handlers";
import { useUIStore } from "@/state/ui";
import { type AgentCode } from "./types";
import { cleanTerminalText } from "@/modules/terminal/lib/terminal-utils";
import { extractCommandFromBuffer, extractCommandFromOsc } from "@/modules/terminal/lib/terminal-buffer-read";
import { isMeaningfulCommand } from "@/modules/terminal/lib/terminal-command";
import { waitForTerminalFontReady } from "@/modules/terminal/lib/terminal-font";
import { createTerminalInstance } from "@/modules/terminal/lib/terminal-instance";
import { registerTerminalFileLinkProvider } from "@/modules/terminal/lib/terminal-file-links";
import { registerTerminalLigatureSync } from "@/modules/terminal/lib/terminal-ligature-sync";
import { createTerminalOutputBuffer } from "@/modules/terminal/lib/terminal-output-buffer";
import { schedulePendingInput } from "@/modules/terminal/lib/terminal-pending-input";
import { createTerminalWebglRenderer } from "@/modules/terminal/lib/terminal-webgl";
import { observeTerminalResize } from "@/modules/terminal/lib/terminal-resize";
import { scanTerminalInputBuffer } from "@/modules/terminal/lib/terminal-input-buffer";
import { detectAgentCommand, HOOK_READY_AGENTS, parseAgentLifecycleOsc, PROMPT_READY_AGENTS } from "@/modules/terminal/lib/agent-lifecycle";
import { createCodexScreenStateTracker } from "@/modules/terminal/lib/terminal-codex-state";
import { getTerminalSnapshot } from "@/modules/terminal/lib/terminal-snapshot";
import { createTerminalSnapshotScheduler } from "@/modules/terminal/lib/terminal-snapshot-scheduler";
import { useSessionsStore } from "@/state/sessions";
import { TerminalViewChrome } from "./TerminalViewChrome";
import { useTerminalSearch } from "./useTerminalSearch";
import { useTerminalBlocks } from "./useTerminalBlocks";
import { useTerminalQuickSelect } from "./useTerminalQuickSelect";
import { useTerminalWebgl, type TerminalWebglRenderer } from "./useTerminalWebgl";
import { useTerminalRuntimeSync } from "./useTerminalRuntimeSync";
interface TerminalViewProps {
  sessionId: string;
  dir: string;
  active: boolean;
  pendingInput?: string;
  pendingInputSubmit?: boolean;
  onPendingInputConsumed?: () => void;
}

function requestInformationalAttention() {
  if (document.hasFocus() || !useUIStore.getState().bellNotification) return;
  getCurrentWindow()
    .requestUserAttention(UserAttentionType.Informational)
    .catch(() => {});
}

export function TerminalView({
  sessionId,
  dir,
  active,
  pendingInput,
  pendingInputSubmit,
  onPendingInputConsumed,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyRef = useRef<PtySession | null>(null);
  const initRef = useRef(false);
  const webglRef = useRef<TerminalWebglRenderer | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const search = useTerminalSearch(termRef);
  const blocks = useTerminalBlocks(termRef);
  const quickSelect = useTerminalQuickSelect(termRef, { active, cwd: dir, sessionId });
  const pendingInputRef = useRef(pendingInput);
  pendingInputRef.current = pendingInput;
  const pendingInputSubmitRef = useRef(pendingInputSubmit);
  pendingInputSubmitRef.current = pendingInputSubmit;
  const onPendingInputConsumedRef = useRef(onPendingInputConsumed);
  onPendingInputConsumedRef.current = onPendingInputConsumed;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const theme = useUIStore((s) => s.theme);
  const fontSize = useUIStore((s) => s.fontSize);
  const fontFamily = useUIStore((s) => s.fontFamily);
  const nerdFontFallback = useUIStore((s) => s.nerdFontFallback);
  const scrollback = useUIStore((s) => s.scrollback);
  const cursorStyle = useUIStore((s) => s.cursorStyle);
  const cursorBlink = useUIStore((s) => s.cursorBlink);
  const terminalTheme = useUIStore((s) => s.terminalTheme);
  const accent = useUIStore((s) => s.accent);
  useTerminalRuntimeSync({
    active, termRef, fitRef, ptyRef, fontSize, fontFamily, nerdFontFallback, scrollback, cursorStyle, cursorBlink, theme, terminalTheme, accent,
  });
  useTerminalWebgl(termRef, active, webglRef);
  useEffect(() => {
    if (initRef.current || !containerRef.current) return;
    initRef.current = true;
    let disposed = false;
    const cleanups: Array<() => void> = [];
    (async () => {
      await waitForTerminalFontReady({ fontSize, fontFamily, nerdFontFallback });
      if (disposed || !containerRef.current) return;
      const term = createTerminalInstance({
        fontSize,
        fontFamily,
        nerdFontFallback,
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
      if (activeRef.current) webglRef.current = createTerminalWebglRenderer(term);
      const serializeAddon = new SerializeAddon();
      term.loadAddon(serializeAddon);
      term.loadAddon(new WebLinksAddon((_event, uri) => {
        try {
          const url = new URL(uri);
          if (url.protocol === "http:" || url.protocol === "https:") {
            openUrl(uri);
          }
        } catch { /* malformed URL, ignore */ }
      }));
      const fileLinkDisposable = registerTerminalFileLinkProvider(term, {
        getCwd: () => useSessionsStore.getState().sessions.find((s) => s.id === sessionIdRef.current)?.dir ?? dir,
        getEditor: () => useUIStore.getState().externalEditor,
      });
      cleanups.push(() => fileLinkDisposable.dispose());
      cleanups.push(registerTerminalLigatureSync(term));
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
      cleanups.push(blocks.registerScrollTracking(term));
      term.attachCustomKeyEventHandler((e) => search.handleCustomKeyEvent(e) && blocks.handleCustomKeyEvent(e));
      // OSC 133 shell integration:
      // A = prompt start, B = prompt end (input start), C = command execution start, D;N = command end (exit code N)
      let hasAgent = false;
      let currentAgentCode: AgentCode | null = null;
      let agentStartupPending = false;
      let osc133Active = false;
      let promptEndRow = -1;
      let lastExitCode = 0;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      const getCurrentSession = () =>
        useSessionsStore.getState().sessions.find((s) => s.id === sessionIdRef.current);
      const codexStateTracker = createCodexScreenStateTracker({
        terminal: term,
        getSessionId: () => sessionIdRef.current,
        getCurrentSession,
        isTrackingCodex: () => hasAgent && currentAgentCode === "CX",
        onBusy: (id) => useSessionsStore.getState().handleAgentBusy(id),
        onReady: (id) => useSessionsStore.getState().handleAgentReady(id),
      });
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
        codexStateTracker.reset();
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
      const markAgentDetected = (agent: AgentCode, command?: string) => {
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
          useSessionsStore.getState().handleAgentDetected(sessionIdRef.current, agent, command);
        } else if (command) {
          useSessionsStore.getState().handleAgentDetected(sessionIdRef.current, agent, command);
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
          requestInformationalAttention();
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
      const currentBufferRow = () => term.buffer.active.cursorY + term.buffer.active.baseY;
      const requestAttentionIfNeeded = () => {
        requestInformationalAttention();
      };
      const agentLifecycleDisposable = term.parser.registerOscHandler(777, applyAgentLifecycleEvent);
      cleanups.push(() => agentLifecycleDisposable.dispose());
      const promptDisposable = term.parser.registerOscHandler(133, (data) => {
        const marker = data.charAt(0);
        const trackedSession = syncAgentTrackingFromStore();
        if (hasAgent || trackedSession?.agent) {
          if (marker === "A") {
            const exitCode = lastExitCode;
            blocks.finishBlock(exitCode, currentBufferRow());
            clearAgentTracking();
            useSessionsStore.getState().handleAgentExited(sessionIdRef.current, exitCode);
            requestAttentionIfNeeded();
            osc133Active = true;
          } else if (marker === "D") {
            const exitCode = parseInt(data.slice(2), 10) || 0;
            lastExitCode = exitCode;
            blocks.finishBlock(exitCode, currentBufferRow());
            clearAgentTracking();
            useSessionsStore.getState().handleAgentExited(sessionIdRef.current, exitCode);
            requestAttentionIfNeeded();
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
                blocks.beginBlock(cmd, promptEndRow >= 0 ? promptEndRow : currentBufferRow());
              }
              const agent = detectAgentCommand(cmd);
              if (agent) {
                markAgentDetected(agent, cmd);
              }
            }
          }
          osc133Active = false;
        } else if (marker === "D") {
          const exitCode = parseInt(data.slice(2), 10) || 0;
          lastExitCode = exitCode;
          blocks.finishBlock(exitCode, currentBufferRow());
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
      const snapshotScheduler = createTerminalSnapshotScheduler({
        term,
        serializeAddon,
        sessionId: () => sessionIdRef.current,
        isActive: () => activeRef.current,
      });
      const scheduleSnapshot = snapshotScheduler.schedule;
      cleanups.push(snapshotScheduler.dispose);
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
              blocks.updateActiveBlockEnd(currentBufferRow());
              scheduleSnapshot();
              if (hasAgent && currentAgentCode) {
                if (PROMPT_READY_AGENTS.has(currentAgentCode)) {
                  codexStateTracker.schedule();
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
      cleanups.push(schedulePendingInput({
        pty,
        input: pendingInputRef.current,
        submit: pendingInputSubmitRef.current !== false,
        onConsumed: onPendingInputConsumedRef.current,
      }).dispose);
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
            markAgentDetected(agent, submitted);
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
        requestInformationalAttention();
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
        codexStateTracker.dispose();
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
      webglRef.current?.dispose();
      webglRef.current = null;
      termRef.current?.dispose();
      termRef.current = null;
    };
    // The PTY cwd is tracked through OSC 7 after spawn. Re-running this effect
    // when `dir` changes would close and recreate the terminal on every `cd`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <TerminalViewChrome containerRef={containerRef} search={search} blocks={blocks.blocks} collapsedBlockIds={blocks.collapsedBlockIds} stickyBlock={blocks.stickyBlock} onCopyBlockCommand={blocks.copyBlockCommand} onCopyBlockCommandAndOutput={blocks.copyBlockCommandAndOutput} onCopyBlockOutput={blocks.copyBlockOutput} onToggleBlock={blocks.toggleBlock} onRevealBlock={blocks.revealBlock} quickSelectOverlay={quickSelect.quickSelectOverlay} />;
}
