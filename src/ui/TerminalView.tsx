import { memo, useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { openUrl } from "@tauri-apps/plugin-opener";
import { openSessionPty, reportSshOpenFailure, type PtySession } from "@/modules/terminal/lib/pty-bridge";
import { takeSshCredentials } from "@/modules/ssh/pending-credentials";
import { registerCwdHandler } from "@/modules/terminal/lib/osc-handlers";
import { useUIStore } from "@/state/ui";
import type { AgentCode } from "./types";
import { cleanTerminalText } from "@/modules/terminal/lib/terminal-utils";
import { extractCommandFromBuffer, extractCommandFromOsc } from "@/modules/terminal/lib/terminal-buffer-read";
import { isMeaningfulCommand } from "@/modules/terminal/lib/terminal-command";
import { waitForTerminalFontReady } from "@/modules/terminal/lib/terminal-font";
import { createTerminalHyperlinkHandler } from "@/modules/terminal/lib/terminal-hyperlinks";
import { createTerminalInstance } from "@/modules/terminal/lib/terminal-instance";
import { handleCopyKeyEvent } from "@/modules/terminal/lib/terminal-copy";
import { registerTerminalFileLinkProvider } from "@/modules/terminal/lib/terminal-file-links";
import { createTerminalLineCwdTracker } from "@/modules/terminal/lib/terminal-line-cwd";
import { registerTerminalLigatureSync } from "@/modules/terminal/lib/terminal-ligature-sync";
import { createTerminalOutputBuffer } from "@/modules/terminal/lib/terminal-output-buffer";
import { registerTerminalImage } from "@/modules/terminal/lib/terminal-image";
import { registerTerminalPasteProtection } from "@/modules/terminal/lib/terminal-paste-protection";
import { schedulePendingInput } from "@/modules/terminal/lib/terminal-pending-input";
import { registerTerminalClipboardHandler } from "@/modules/terminal/lib/terminal-clipboard";
import { registerTerminalDeviceAttributesHandler } from "@/modules/terminal/lib/terminal-device-attributes";
import { registerTerminalOsc9Handler } from "@/modules/terminal/lib/terminal-osc9";
import { parseTerminalNotificationOsc777 } from "@/modules/terminal/lib/terminal-notification";
import { observeTerminalResize } from "@/modules/terminal/lib/terminal-resize";
import { scanTerminalInputBuffer } from "@/modules/terminal/lib/terminal-input-buffer";
import { detectAgentCommand, HOOK_READY_AGENTS, parseAgentLifecycleOsc, PROMPT_READY_AGENTS, shouldUseStartupQuietReadyFallback } from "@/modules/terminal/lib/agent-lifecycle";
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
import { createInputQueueFullWarner, emitTerminalNotification, requestInformationalAttention, safeDispose } from "./terminal-attention";
interface TerminalViewProps {
  sessionId: string;
  dir: string;
  active: boolean;
  pendingInput?: string;
  pendingInputSubmit?: boolean;
  /** Called with this view's session id once pendingInput has been delivered. */
  onPendingInputConsumed?: (sessionId: string) => void;
}

function TerminalViewImpl({
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
  // Gates the pendingInput effect to fire once when the PTY is ready.
  const [ptyReady, setPtyReady] = useState(false);
  const webglRef = useRef<TerminalWebglRenderer | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;
  const search = useTerminalSearch(termRef);
  const blocks = useTerminalBlocks(termRef);
  const quickSelect = useTerminalQuickSelect(termRef, { active, cwd: dir, sessionId });
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
  useTerminalWebgl(termRef, active, webglRef, sessionId, ptyReady);
  // Sole delivery path for pendingInput (init effect must NOT also schedule it).
  useEffect(() => {
    const pty = ptyRef.current;
    if (!pendingInput || !pty) return;
    return schedulePendingInput({
      pty,
      input: pendingInput,
      submit: pendingInputSubmit !== false,
      onConsumed: () => onPendingInputConsumed?.(sessionIdRef.current),
    }).dispose;
  }, [pendingInput, pendingInputSubmit, onPendingInputConsumed, ptyReady]);
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
        linkHandler: createTerminalHyperlinkHandler(openUrl),
      });
      termRef.current = term;
      const fit = new FitAddon();
      fitRef.current = fit;
      term.loadAddon(fit);
      term.open(containerRef.current);
      cleanups.push(registerTerminalPasteProtection(term).dispose);
      cleanups.push(registerTerminalClipboardHandler(term, {
        isWriteAllowed: () => useUIStore.getState().terminalClipboardWrite,
      }));
      cleanups.push(registerTerminalDeviceAttributesHandler(term, {
        isOsc52ClipboardWriteAllowed: () => useUIStore.getState().terminalClipboardWrite,
      }));
      // WebGL renderer is managed by useTerminalWebgl (LRU context pool).
      // Inline images (SIXEL + iTerm IIP), loaded after WebGL so it adopts the
      // active renderer. Opt-out via Settings; takes effect on the next terminal.
      if (useUIStore.getState().terminalInlineImages) {
        cleanups.push(registerTerminalImage(term));
      }
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
      const lineCwdTracker = createTerminalLineCwdTracker();
      const initialCwd = dir === "~" ? undefined : dir;
      if (initialCwd) lineCwdTracker.record(initialCwd, term.registerMarker(0));
      cleanups.push(lineCwdTracker.dispose);
      const fileLinkDisposable = registerTerminalFileLinkProvider(term, {
        getCwd: (line) => lineCwdTracker.getCwdForLine(line, useSessionsStore.getState().sessions.find((s) => s.id === sessionIdRef.current)?.dir ?? dir),
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
      // ⌘C copy runs first: on a selection it copies and short-circuits the chain
      // (returns false) so search/blocks don't see the key; otherwise it passes through.
      term.attachCustomKeyEventHandler((e) => handleCopyKeyEvent(term, e) && search.handleCustomKeyEvent(e) && blocks.handleCustomKeyEvent(e));
      // OSC 133 shell integration:
      // A = prompt start, B = prompt end (input start), C = command execution start, D;N = command end (exit code N)
      let hasAgent = false;
      let currentAgentCode: AgentCode | null = null;
      let agentStartupPending = false;
      let osc133Active = false;
      let promptEndRow = -1;
      let lastExitCode = 0;
      let startupReadyTimer: ReturnType<typeof setTimeout> | null = null;
      const getCurrentSession = () =>
        useSessionsStore.getState().sessions.find((s) => s.id === sessionIdRef.current);
      const handleCwdChange = (cwd: string) => {
        lineCwdTracker.record(cwd, term.registerMarker(0));
        useSessionsStore.getState().handleCwdChange(sessionIdRef.current, cwd);
      };
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
        if (startupReadyTimer) {
          clearTimeout(startupReadyTimer);
          startupReadyTimer = null;
        }
        codexStateTracker.reset();
      };
      const scheduleStartupQuietReady = (delay = 3000) => {
        if (startupReadyTimer) clearTimeout(startupReadyTimer);
        startupReadyTimer = setTimeout(() => {
          startupReadyTimer = null;
          const s = getCurrentSession();
          if (!shouldUseStartupQuietReadyFallback(currentAgentCode, s?.agentActivity, agentStartupPending)) return;
          agentStartupPending = false;
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
        if (startupReadyTimer) {
          clearTimeout(startupReadyTimer);
          startupReadyTimer = null;
        }
        if (sess?.agent !== agent) {
          useSessionsStore.getState().handleAgentDetected(sessionIdRef.current, agent, command);
        } else if (command) {
          useSessionsStore.getState().handleAgentDetected(sessionIdRef.current, agent, command);
        }
      };
      const applyAgentLifecycleEvent = (data: string) => {
        const notification = parseTerminalNotificationOsc777(data);
        if (notification) {
          emitTerminalNotification(sessionIdRef.current, notification);
          return true;
        }
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
          } else if (sess?.agent && currentAgentCode === sess.agent && HOOK_READY_AGENTS.has(sess.agent)) {
            agentStartupPending = sess.agentActivity === "starting";
          } else if (!sess?.agent && hasAgent) {
            clearAgentTracking();
          }
        }),
      );
      cleanups.push(registerCwdHandler(term, handleCwdChange));
      const titleDisposable = term.onTitleChange((title) => {
        const clean = cleanTerminalText(title);
        if (clean) useSessionsStore.getState().handleShellTitle(sessionIdRef.current, clean);
      });
      cleanups.push(() => titleDisposable.dispose());
      const currentBufferRow = () => term.buffer.active.cursorY + term.buffer.active.baseY;
      const agentLifecycleDisposable = term.parser.registerOscHandler(777, applyAgentLifecycleEvent);
      cleanups.push(() => agentLifecycleDisposable.dispose());
      cleanups.push(registerTerminalOsc9Handler(term, {
        onProgress: (progress) => {
          useSessionsStore.getState().handleTerminalProgress(sessionIdRef.current, progress);
        },
        onNotification: (notification) => emitTerminalNotification(sessionIdRef.current, notification),
        onCwd: handleCwdChange,
      }));
      const promptDisposable = term.parser.registerOscHandler(133, (data) => {
        const marker = data.charAt(0);
        const trackedSession = syncAgentTrackingFromStore();
        if (hasAgent || trackedSession?.agent) {
          if (marker === "A") {
            const exitCode = lastExitCode;
            blocks.finishBlock(exitCode, currentBufferRow());
            clearAgentTracking();
            useSessionsStore.getState().handleAgentExited(sessionIdRef.current, exitCode);
            requestInformationalAttention();
            osc133Active = true;
          } else if (marker === "D") {
            const exitCode = parseInt(data.slice(2), 10) || 0;
            lastExitCode = exitCode;
            blocks.finishBlock(exitCode, currentBufferRow());
            clearAgentTracking();
            useSessionsStore.getState().handleAgentExited(sessionIdRef.current, exitCode);
            requestInformationalAttention();
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
        term.write("\r\n\x1b[2m[tunara restored snapshot, new shell started below]\x1b[0m\r\n");
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
      const ptyHandlers = {
        onData: (bytes: Uint8Array) => {
          outputBuffer.push(bytes);
          blocks.updateActiveBlockEnd(currentBufferRow());
          scheduleSnapshot();
          if (hasAgent && currentAgentCode) {
            if (PROMPT_READY_AGENTS.has(currentAgentCode)) {
              codexStateTracker.schedule();
              return;
            }
            const sess = getCurrentSession();
            if (shouldUseStartupQuietReadyFallback(currentAgentCode, sess?.agentActivity, agentStartupPending)) {
              scheduleStartupQuietReady();
            }
          }
        },
        onExit: (code: number) => {
          term.write(`\r\n\x1b[2m[process exited: ${code}]\x1b[0m\r\n`);
          term.options.disableStdin = true;
        },
      };
      let pty;
      try {
        // Remote (SSH) and local sessions share the PtySession interface and
        // the pty_write/resize/close commands; openSessionPty picks the opener.
        const sessionRemote = getCurrentSession()?.remote;
        // One-shot credentials (password / passphrase) live outside the Session
        // object so they're never persisted; merge them in only for this open.
        const creds = sessionRemote ? takeSshCredentials(sessionIdRef.current) : undefined;
        pty = await openSessionPty(sessionIdRef.current, term.cols, term.rows, ptyHandlers, {
          cwd,
          remote: sessionRemote
            ? { ...sessionRemote, password: creds?.password, keyPassphrase: creds?.keyPassphrase }
            : undefined,
        });
      } catch (e) {
        term.write(`\r\n\x1b[31m[PTY error: ${e}]\x1b[0m\r\n`);
        // Surface SSH/connection failures as a Toast + failed state too (a lone
        // red line is easy to miss / indistinguishable from "still connecting").
        reportSshOpenFailure(sessionIdRef.current, getCurrentSession()?.remote, String(e));
        return;
      }
      if (disposed) {
        pty.close().catch(() => {});
        return;
      }
      ptyRef.current = pty;
      setPtyReady(true); // triggers the pendingInput effect once, now that pty is live

      // Expose the live PTY id on the session so the remote file panel can
      // locate the backend SSH connection for SFTP commands.
      useSessionsStore.getState().updateSession(sessionIdRef.current, { ptyId: pty.id });
      const onWriteError = createInputQueueFullWarner(term);
      const writePty = (data: string) => {
        pty.write(data).catch(onWriteError);
      };
      const resizePty = (cols: number, rows: number) => {
        pty.resize(cols, rows).catch(() => {
          /* Resize can race with process exit or pane teardown. */
        });
      };
      // pendingInput is delivered solely by the top-level effect (keyed on ptyReady).
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
          if (startupReadyTimer) {
            clearTimeout(startupReadyTimer);
            startupReadyTimer = null;
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
        if (startupReadyTimer) {
          clearTimeout(startupReadyTimer);
          startupReadyTimer = null;
        }
        codexStateTracker.dispose();
      });
      if (active) term.focus();
    })();
    return () => {
      disposed = true;
      // Run every cleanup even if one throws — a failing disposable must not
      // leak the rest (term.dispose / pty.close would be skipped otherwise).
      for (const fn of cleanups) safeDispose("step", fn);
      if (ptyRef.current) {
        ptyRef.current.close().catch(() => {});
        ptyRef.current = null;
      }
      safeDispose("webgl", () => webglRef.current?.dispose());
      webglRef.current = null;
      // Note: useTerminalWebgl's own cleanup also removes from the LRU pool.
      safeDispose("term", () => termRef.current?.dispose());
      termRef.current = null;
    };
    // The PTY cwd is tracked through OSC 7 after spawn. Re-running this effect
    // when `dir` changes would close and recreate the terminal on every `cd`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <TerminalViewChrome containerRef={containerRef} getTerminal={() => termRef.current} search={search} blocks={blocks.blocks} collapsedBlockIds={blocks.collapsedBlockIds} stickyBlock={blocks.stickyBlock} onCopyBlockCommand={blocks.copyBlockCommand} onCopyBlockCommandAndOutput={blocks.copyBlockCommandAndOutput} onCopyBlockOutput={blocks.copyBlockOutput} onReadBlockOutput={blocks.readBlockOutput} onToggleBlock={blocks.toggleBlock} onRevealBlock={blocks.revealBlock} quickSelectOverlay={quickSelect.quickSelectOverlay} />;
}

// Memoized (with stable props from MainArea) so a MainArea re-render on each
// agent heartbeat doesn't re-render every mounted terminal.
export const TerminalView = memo(TerminalViewImpl);
