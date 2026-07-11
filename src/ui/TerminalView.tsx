import { memo, useEffect, useRef, useState } from "react";
import type { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { confirm as tauriConfirmDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cancelSshOpen, openSessionPty, recordPtyConnectionStatus, recordPtyExit, reportSshOpenFailure, type PtyConnectionStatusPhase, type PtySession } from "@/modules/terminal/lib/pty-bridge";
import { takeSshCredentials } from "@/modules/ssh/pending-credentials";
import { registerCwdHandler } from "@/modules/terminal/lib/osc-handlers";
import { useUIStore } from "@/state/ui"; import { t } from "@/modules/i18n";
import type { AgentCode } from "./types";
import { cleanTerminalText } from "@/modules/terminal/lib/terminal-utils";
import { extractCommandFromBuffer, resolveTerminalCommandText } from "@/modules/terminal/lib/terminal-buffer-read";
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
import { parseTerminalNotificationOsc777 } from "@/modules/terminal/lib/terminal-notification"; import { observeTerminalResize } from "@/modules/terminal/lib/terminal-resize";
import { createWebglAtlasRebuilder, registerTerminalAtlasRefresh } from "@/modules/terminal/lib/terminal-atlas-refresh";
import { detectAgentCommand, parseAgentLifecycleOsc, PROMPT_READY_AGENTS, shouldUseStartupQuietReadyFallback } from "@/modules/terminal/lib/agent-lifecycle";
import { detectSshCommand } from "@/modules/terminal/lib/ssh-command-detect"; import { createPromptAgentScreenStateTracker } from "@/modules/terminal/lib/terminal-prompt-agent-state";
import { scanTerminalInputBuffer, shouldScanTerminalInput } from "@/modules/terminal/lib/terminal-input-buffer";
import { getTerminalSnapshot } from "@/modules/terminal/lib/terminal-snapshot"; import { createTerminalSnapshotScheduler } from "@/modules/terminal/lib/terminal-snapshot-scheduler";
import { useSessionsStore } from "@/state/sessions"; import { TerminalViewChrome } from "./TerminalViewChrome"; import { useTerminalSearch } from "./useTerminalSearch";
import { useTerminalBlocks } from "./useTerminalBlocks"; import { useTerminalQuickSelect } from "./useTerminalQuickSelect"; import { useTerminalWebgl, type TerminalWebglRenderer } from "./useTerminalWebgl"; import { useTerminalRuntimeSync } from "./useTerminalRuntimeSync";
import { createInputQueueFullWarner, emitTerminalNotification, reportTerminalInitializationFailure, requestInformationalAttention, safeDispose } from "./terminal-attention"; import { handleTerminalProcessExit } from "./terminal-exit";
import { waitForTerminalLayoutFrame } from "@/modules/terminal/lib/terminal-layout-frame"; import { recordTerminalBenchmarkOutput, recordTerminalBenchmarkOverflow, registerTerminalBenchmarkSnapshotReader, registerTerminalBenchmarkWriter, TERMINAL_BENCHMARK_MODE } from "@/modules/terminal/lib/terminal-benchmark"; import { TerminalExitBanner, PtyErrorBanner, ConnectingOverlay } from "./TerminalExitBanner";
interface TerminalViewProps {
  sessionId: string;
  dir: string;
  active: boolean;
  pendingInput?: string;
  pendingInputSubmit?: boolean;
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
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const session = useSessionsStore((s) => s.sessions.find((x) => x.id === sessionId));
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
    active, termRef, fitRef, ptyRef, webglRef, fontSize, fontFamily, nerdFontFallback, scrollback, cursorStyle, cursorBlink, theme, terminalTheme, accent,
  });
  useTerminalWebgl(termRef, active, webglRef, sessionId, ptyReady);
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
      // Confirmer must be the Tauri dialog: window.confirm never renders in
      // wry's WKWebView and would silently drop every multiline/large paste.
      cleanups.push(registerTerminalPasteProtection(term, (message) =>
        tauriConfirmDialog(message, { kind: "warning" })).dispose);
      cleanups.push(registerTerminalClipboardHandler(term, {
        isWriteAllowed: () => useUIStore.getState().terminalClipboardWrite,
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
        } catch (e) { console.debug("[TerminalView] malformed URL in web link, ignoring", uri, e); }
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
      const rebuildWebglAtlas = createWebglAtlasRebuilder(webglRef);
      cleanups.push(registerTerminalLigatureSync(term, rebuildWebglAtlas));
      // Fit after WebGL addon loads — the addon replaces the renderer and
      // changes cell metrics; fitting before it loads would measure stale
      // dimensions, causing a cols/rows mismatch with the PTY that shows
      // as garbled output until the next resize.
      await waitForTerminalLayoutFrame();
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
      // OSC 133: A prompt start, B input start, C command start, D;N command end.
      let osc133Active = false;
      let osc133InputFallback = false;
      let pendingSubmittedShellCommand: string | null = null;
      let promptEnd = { row: -1, column: 0 };
      let lastExitCode = 0;
      let startupReadyTimer: ReturnType<typeof setTimeout> | null = null;
      const getCurrentSession = () =>
        useSessionsStore.getState().sessions.find((s) => s.id === sessionIdRef.current);
      const handleCwdChange = (cwd: string) => {
        lineCwdTracker.record(cwd, term.registerMarker(0));
        useSessionsStore.getState().handleCwdChange(sessionIdRef.current, cwd);
      };
      const promptAgentStateTracker = createPromptAgentScreenStateTracker({
        terminal: term,
        getSessionId: () => sessionIdRef.current,
        getCurrentSession,
        onBusy: (id) => useSessionsStore.getState().handleAgentBusy(id),
        onWaitingConfirmation: (id) => useSessionsStore.getState().handleAgentWaitingConfirmation(id),
        onReady: (id) => useSessionsStore.getState().handleAgentReady(id),
      });
      const resetAgentObservers = () => {
        if (startupReadyTimer) {
          clearTimeout(startupReadyTimer);
          startupReadyTimer = null;
        }
        promptAgentStateTracker.reset();
      };
      const scheduleStartupQuietReady = (delay = 3000) => {
        if (startupReadyTimer) clearTimeout(startupReadyTimer);
        startupReadyTimer = setTimeout(() => {
          startupReadyTimer = null;
          const s = getCurrentSession();
          if (!shouldUseStartupQuietReadyFallback(s?.agent, s?.agentActivity)) return;
          useSessionsStore.getState().handleAgentReady(sessionIdRef.current);
        }, delay);
      };
      const markAgentDetected = (agent: AgentCode, command?: string) => {
        if (startupReadyTimer) {
          clearTimeout(startupReadyTimer);
          startupReadyTimer = null;
        }
        promptAgentStateTracker.reset();
        useSessionsStore.getState().handleAgentDetected(sessionIdRef.current, agent, command);
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
          if (payload.agentSessionId) useSessionsStore.getState().recordAgentSessionId(sessionIdRef.current, payload.agent, payload.agentSessionId);
          return true;
        }
        const current = getCurrentSession();
        if (!current?.agent || current.agent !== payload.agent) return true;
        if (payload.event === "exit") {
          resetAgentObservers();
          useSessionsStore.getState().handleAgentExited(sessionIdRef.current, payload.code ?? lastExitCode);
          requestInformationalAttention();
          return true;
        }
        if (payload.agentSessionId) {
          useSessionsStore.getState().recordAgentSessionId(sessionIdRef.current, payload.agent, payload.agentSessionId);
        }
        if (payload.event === "busy" || payload.event === "wait") {
          resetAgentObservers();
          if (payload.event === "busy") useSessionsStore.getState().handleAgentBusy(sessionIdRef.current);
          else useSessionsStore.getState().handleAgentWaitingConfirmation(sessionIdRef.current);
          return true;
        }
        if (payload.event === "idle" || payload.event === "stop") {
          resetAgentObservers();
          useSessionsStore.getState().handleAgentReady(sessionIdRef.current);
        }
        return true;
      };
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
        const trackedSession = getCurrentSession();
        if (trackedSession?.agent) { const shellMarker = data.includes(";tunara-shell");
          if (marker === "A" && shellMarker) {
            const exitCode = lastExitCode;
            blocks.finishBlock(exitCode, currentBufferRow());
            resetAgentObservers();
            useSessionsStore.getState().handleAgentExited(sessionIdRef.current, exitCode);
            requestInformationalAttention();
            osc133Active = true;
          } else if (marker === "D" && shellMarker) {
            const exitCode = parseInt(data.slice(2), 10) || 0;
            lastExitCode = exitCode;
            blocks.finishBlock(exitCode, currentBufferRow());
            resetAgentObservers();
            useSessionsStore.getState().handleAgentExited(sessionIdRef.current, exitCode);
            requestInformationalAttention();
          }
          return true;
        }
        if (marker === "A") {
          osc133Active = true;
          osc133InputFallback = data.endsWith(";input-fallback");
          pendingSubmittedShellCommand = null;
          promptEnd = { row: -1, column: 0 };
        } else if (marker === "B") {
          promptEnd = { row: term.buffer.active.cursorY + term.buffer.active.baseY, column: term.buffer.active.cursorX };
        } else if (marker === "C") {
          osc133InputFallback = false;
          const submittedCommand = pendingSubmittedShellCommand; pendingSubmittedShellCommand = null;
          if (osc133Active && (promptEnd.row >= 0 || submittedCommand || data.startsWith("C;"))) {
            const cmd = resolveTerminalCommandText(data, submittedCommand, extractCommandFromBuffer(term, promptEnd));
            if (cmd) {
              if (isMeaningfulCommand(cmd)) {
                useSessionsStore.getState().handleCommandDetected(sessionIdRef.current, cmd);
                blocks.beginBlock(cmd, promptEnd.row >= 0 ? promptEnd.row : currentBufferRow());
              }
              const agent = detectAgentCommand(cmd);
              if (agent) {
                markAgentDetected(agent, cmd);
              }
              // 本地会话默认注入 OSC 133,命令文本走这条路径(非 fallback)——
              // ssh 检测必须同样挂在这里,否则提示条对绝大多数本地会话永不出现。
              const sshTarget = detectSshCommand(cmd);
              if (sshTarget) {
                useSessionsStore.getState().suggestSshConnect(sessionIdRef.current, sshTarget);
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
        const rl = getCurrentSession()?.remote ? t("terminal.restored_remote") : t("terminal.restored_local");
        term.write(existingSnapshot.serialized + `\r\n\x1b[2m[${rl}]\x1b[0m\r\n`);
        requestAnimationFrame(() => { if (existingSnapshot.viewportY !== undefined) term.scrollToLine(existingSnapshot.viewportY); });
      }
      const snapshotScheduler = createTerminalSnapshotScheduler({
        term,
        serializeAddon,
        sessionId: () => sessionIdRef.current,
        isActive: () => activeRef.current,
        shouldCapture: () => useSessionsStore.getState().sessions.some((s) => s.id === sessionIdRef.current),
      });
      cleanups.push(snapshotScheduler.dispose);
      const cwd = dir === "~" ? undefined : dir;
      const transport = getCurrentSession()?.remote ? "ssh" : "local";
      useSessionsStore.getState().handleConnectionEvent(sessionIdRef.current, {
        type: "openRequested",
        transport,
      });
      const outputBuffer = createTerminalOutputBuffer(term, { onOverflow: TERMINAL_BENCHMARK_MODE ? () => recordTerminalBenchmarkOverflow(sessionIdRef.current) : undefined });
      cleanups.push(() => outputBuffer.dispose());
      if (TERMINAL_BENCHMARK_MODE) cleanups.push(registerTerminalBenchmarkSnapshotReader(sessionIdRef.current, async () => { await outputBuffer.drain(); return serializeAddon.serialize(); }));
      // Declared before ptyHandlers so onExit can flip it even if exit races the
      // await openSessionPty() return.
      let inputToPtyEnabled = true;
      const ptyHandlers = {
        onData: (bytes: Uint8Array, acknowledge: () => void) => { if (TERMINAL_BENCHMARK_MODE) recordTerminalBenchmarkOutput(sessionIdRef.current, bytes);
          outputBuffer.push(bytes, acknowledge);
          blocks.updateActiveBlockEnd(currentBufferRow());
          snapshotScheduler.schedule();
          const current = getCurrentSession();
          if (current?.agent) {
            if (PROMPT_READY_AGENTS.has(current.agent)) {
              promptAgentStateTracker.schedule();
              return;
            }
            if (shouldUseStartupQuietReadyFallback(current.agent, current.agentActivity)) {
              scheduleStartupQuietReady();
            }
          }
        },
        onExit: (code: number) => {
          if (disposed) return;
          inputToPtyEnabled = false;
          recordPtyExit(sessionIdRef.current, Boolean(getCurrentSession()?.remote), code);
          handleTerminalProcessExit(term, sessionIdRef.current, code, Boolean(getCurrentSession()?.remote));
          snapshotScheduler.flush();
          setExitCode(code);
        },
        onConnectionStatus: (phase: PtyConnectionStatusPhase) => {
          recordPtyConnectionStatus(sessionIdRef.current, phase);
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
        if (disposed) return;
        term.write(`\r\n\x1b[31m[PTY error: ${e}]\x1b[0m\r\n`);
        setOpenError(String(e));
        const cur = getCurrentSession();
        reportSshOpenFailure(sessionIdRef.current, cur?.remote, String(e));
        if (!cur?.remote) {
          useSessionsStore.getState().handleConnectionEvent(sessionIdRef.current, {
            type: "failed",
            transport: "local",
            reason: "pty",
            detail: String(e),
          });
          useUIStore.getState().addToast({ sessionId: sessionIdRef.current, title: t("pty.error.title"), subtitle: t("pty.error.subtitle"), variant: "error" });
        }
        return;
      }
      if (disposed) {
        pty.close().catch(() => {});
        return;
      }
      ptyRef.current = pty;
      if (TERMINAL_BENCHMARK_MODE) cleanups.push(registerTerminalBenchmarkWriter(sessionIdRef.current, (data) => pty.write(data)));
      setPtyReady(true); // triggers the pendingInput effect once, now that pty is live
      if (transport === "local") {
        useSessionsStore.getState().handleConnectionEvent(sessionIdRef.current, {
          type: "ready",
          transport: "local",
        });
      }
      // Expose the live PTY id on the session so the remote file panel can
      // locate the backend SSH connection for SFTP commands.
      useSessionsStore.getState().updateSession(sessionIdRef.current, { ptyId: pty.id });
      const onWriteError = createInputQueueFullWarner(term);
      const writePty = (data: string) => {
        if (!inputToPtyEnabled) return;
        pty.write(data).catch(onWriteError);
      };
      cleanups.push(registerTerminalDeviceAttributesHandler(term, {
        isOsc52ClipboardWriteAllowed: () => useUIStore.getState().terminalClipboardWrite,
        sendInput: writePty,
      }));
      const resizePty = (cols: number, rows: number) => {
        pty.resize(cols, rows).catch(() => {
          /* Resize can race with process exit or pane teardown. */
        });
      };
      let inputState = { buffer: "", bracketedPasteActive: false };
      const submitCommandBuffer = (submitted: string) => {
        const trimmed = cleanTerminalText(submitted).trim();
        const currentAgent = getCurrentSession()?.agent;
        if (!currentAgent && trimmed) pendingSubmittedShellCommand = trimmed;
        // Submitted input is exact and already crossed Enter; detect here so a
        // later PS0/C screen read cannot lose launch provenance.
        if (!currentAgent) {
          const agent = detectAgentCommand(submitted);
          if (agent) markAgentDetected(agent, submitted);
        }
        if (!shouldScanTerminalInput(osc133Active, osc133InputFallback)) return;
        if (!currentAgent && trimmed && isMeaningfulCommand(trimmed)) {
          useSessionsStore.getState().handleCommandDetected(sessionIdRef.current, trimmed);
        }
        // 本地会话里手敲 ssh:提示「改用内置 SSH 打开远程文件」。
        // suggestSshConnect 内部已守卫远程会话/已忽略 host,这里只做检测。
        const sshTarget = detectSshCommand(submitted);
        if (sshTarget) {
          useSessionsStore.getState().suggestSshConnect(sessionIdRef.current, sshTarget);
        }
      };
      const dataDisposable = term.onData((data) => {
        if (!inputToPtyEnabled) return;
        writePty(data);
        const submitAgentInput = (submitted: string) => {
          const sess = getCurrentSession();
          if (!sess?.agent) return;
          const trimmed = cleanTerminalText(submitted).trim();
          if (!trimmed) return;
          if (startupReadyTimer) {
            clearTimeout(startupReadyTimer);
            startupReadyTimer = null;
          }
          if (sess.agentActivity !== "running") {
            useSessionsStore.getState().handleAgentBusy(sessionIdRef.current);
          }
        };
        const result = scanTerminalInputBuffer(inputState.buffer, data, inputState.bracketedPasteActive);
        inputState = result;
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
        rebuildAtlas: rebuildWebglAtlas,
      }));
      // Self-heal the idle-garble case: rebuild the WebGL atlas on focus /
      // visibility regain (see terminal-atlas-refresh for the root cause).
      cleanups.push(registerTerminalAtlasRefresh(rebuildWebglAtlas));
      cleanups.push(resetAgentObservers);
      if (active) term.focus();
    })().catch((error) => {
      if (!disposed) setOpenError(reportTerminalInitializationFailure(sessionIdRef.current, Boolean(session?.remote), error));
    });
    return () => {
      disposed = true; initRef.current = false; // Fast Refresh preserves refs across effect lifecycles.
      if (!ptyRef.current && session?.remote) {
        void cancelSshOpen(sessionIdRef.current);
      }
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
  return (
    <>
      <TerminalViewChrome containerRef={containerRef} getTerminal={() => termRef.current} search={search} blocks={blocks.blocks} collapsedBlockIds={blocks.collapsedBlockIds} stickyBlock={blocks.stickyBlock} onCopyBlockCommand={blocks.copyBlockCommand} onCopyBlockCommandAndOutput={blocks.copyBlockCommandAndOutput} onCopyBlockOutput={blocks.copyBlockOutput} onReadBlockOutput={blocks.readBlockOutput} onToggleBlock={blocks.toggleBlock} onRevealBlock={blocks.revealBlock} quickSelectOverlay={quickSelect.quickSelectOverlay} />
      {!ptyReady && !openError && !exitCode && <ConnectingOverlay phase={session?.connection?.phase} onCancel={() => {
        void cancelSshOpen(sessionId);
        useSessionsStore.getState().closeSession(sessionId);
      }} />}
      {exitCode !== null && session && <TerminalExitBanner session={session} exitCode={exitCode} />}
      {openError !== null && session && <PtyErrorBanner session={session} error={openError} />}
    </>
  );
}
// Memoized (with stable props from MainArea) so a MainArea re-render on each
// agent heartbeat doesn't re-render every mounted terminal.
export const TerminalView = memo(TerminalViewImpl);
