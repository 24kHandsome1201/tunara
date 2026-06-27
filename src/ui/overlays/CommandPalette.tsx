import type React from "react";
import { useEffect, useRef, useState, useMemo } from "react";
import { deriveTitle, type Session } from "../types";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";
import { SearchIcon } from "../shared";
import { formatShortcut } from "../formatShortcut";
import { TERMINAL_QUICK_SELECT_EVENT } from "@/modules/terminal/lib/terminal-quick-select";
import { filterCommandPaletteItems, parseCommandPaletteQuery, rankCommandPaletteItems, type CommandPaletteScope } from "./command-palette-filter";
import { collectRecentTerminalCommands, collectRecentTerminalDirs } from "./command-palette-recents";
import { useWorkflowsStore } from "@/state/workflows";
import { hasPromptableParams, resolveTemplate } from "@/modules/workflows/template";
import { useT } from "@/modules/i18n";
import { useFocusTrap } from "./useFocusTrap";

interface Command {
  id: string;
  label: string;
  subtitle?: string;
  shortcut?: string;
  icon?: React.ReactNode;
  action: () => void;
  section: string;
  scopes: CommandPaletteScope[];
  originalIndex: number;
}

function CmdIcon({ d, size = 14 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d={d} />
    </svg>
  );
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const composingRef = useRef(false);
  useFocusTrap(dialogRef);

  const sessions = useSessionsStore((s) => s.sessions);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const recentDirs = useSessionsStore((s) => s.recentDirs);
  const recentCommands = useSessionsStore((s) => s.recentCommands);
  const setActive = useSessionsStore((s) => s.setActive);
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;
  const uiStore = useUIStore;
  const usage = useUIStore((s) => s.commandUsage);
  const keybindings = useUIStore((s) => s.keybindings);
  const sidebarVisible = useUIStore((s) => s.sidebarVisible);
  const panelVisible = useUIStore((s) => s.panelVisible);
  const workflows = useWorkflowsStore((s) => s.workflows);

  function notifyBatchCloseConfirmation(subtitle: string) {
    const st = useSessionsStore.getState();
    const sessionId = st.activeSessionId ?? st.sessions[0]?.id;
    if (!sessionId) return;
    uiStore.getState().addToast({
      sessionId,
      title: t("palette.toast.confirm_again"),
      subtitle,
      variant: "error",
    });
  }

  const commands = useMemo((): Command[] => {
    const cmds: Command[] = [];
    let idx = 0;

    [...sessions]
      .filter((s: Session) => s.id !== activeSessionId)
      .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)))
      .forEach((s: Session) => {
        const { primary, subtitle } = deriveTitle(s);
        cmds.push({
          id: `switch-${s.id}`,
          label: primary,
          subtitle,
          icon: s.pinned ? <CmdIcon d="M12 3l3 6 6 .9-4.5 4.3 1.1 6.1L12 17.4 6.4 20.3l1.1-6.1L3 9.9 9 9z" /> : <CmdIcon d="M4 17l6-6-6-6M12 19h8" />,
          section: s.pinned ? t("palette.section.pinned_sessions") : t("palette.section.session"),
          scopes: ["session"],
          originalIndex: idx++,
          action: () => { setActive(s.id); uiStore.getState().recordCommandUse(`switch-${s.id}`); onClose(); },
        });
      });

    cmds.push({
      id: "new-terminal",
      label: t("palette.cmd.new_terminal"),
      shortcut: formatShortcut(keybindings.newTerminal),
      icon: <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>,
      section: t("palette.section.action"),
      scopes: ["action", "terminal"],
      originalIndex: idx++,
      action: () => {
        uiStore.getState().recordCommandUse("new-terminal");
        useSessionsStore.getState().newTerminal();
        onClose();
      },
    });

    cmds.push({
      id: "new-ssh-session",
      label: t("palette.cmd.new_ssh_session"),
      icon: <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m6 9 3 3-3 3" /><line x1="12" y1="15" x2="16" y2="15" /></svg>,
      section: t("palette.section.action"),
      scopes: ["action", "terminal"],
      originalIndex: idx++,
      action: () => {
        uiStore.getState().recordCommandUse("new-ssh-session");
        uiStore.getState().setOverlay("ssh");
      },
    });

    if (activeSession) {
      const openInspectorTab = (tab: "overview" | "notes", usageId: string) => {
        uiStore.getState().recordCommandUse(usageId);
        uiStore.getState().setPanelVisible(true);
        uiStore.getState().setInspectorTab(tab);
        onClose();
      };
      const activeIsLocal = !activeSession.remote;

      if (activeIsLocal) {
        cmds.push({
          id: "new-terminal-current-dir",
          label: t("palette.cmd.new_terminal_current_dir"),
          subtitle: activeSession.dir,
          icon: <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M12 5v14M5 12h14" /><path d="M3 6h6l2 2h10v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>,
          section: t("palette.section.action"),
          scopes: ["action", "terminal"],
          originalIndex: idx++,
          action: () => {
            uiStore.getState().recordCommandUse("new-terminal-current-dir");
            useSessionsStore.getState().newTerminalInDir(activeSession.dir);
            onClose();
          },
        });
      }

      for (const entry of collectRecentTerminalDirs(recentDirs, activeSession.dir)) {
        cmds.push({
          id: `new-terminal-recent-dir-${entry.dir}`,
          label: t("palette.cmd.new_terminal_in_dir", { label: entry.label }),
          subtitle: entry.dir,
          icon: <CmdIcon d="M3 6h6l2 2h10v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
          section: t("palette.section.recent_dirs"),
          scopes: ["action", "terminal", "recent"],
          originalIndex: idx++,
          action: () => {
            uiStore.getState().recordCommandUse(`new-terminal-recent-dir-${entry.dir}`);
            useSessionsStore.getState().newTerminalInDir(entry.dir);
            onClose();
          },
        });
      }

      if (activeIsLocal) {
        for (const entry of collectRecentTerminalCommands(recentCommands, activeSession.lastCommand)) {
          cmds.push({
            id: `new-terminal-recent-command-${entry.command}`,
            label: t("palette.cmd.fill_recent_command", { label: entry.label }),
            subtitle: activeSession.dir,
            icon: <CmdIcon d="M4 17l6-6-6-6M12 19h8" />,
            section: t("palette.section.recent_commands"),
            scopes: ["action", "terminal", "recent"],
            originalIndex: idx++,
            action: () => {
              uiStore.getState().recordCommandUse(`new-terminal-recent-command-${entry.command}`);
              useSessionsStore.getState().newTerminalWithInput(entry.command, activeSession.dir);
              onClose();
            },
          });
        }
      }

      // Saved command-template workflows. Local sessions can run them directly;
      // remote sessions intentionally skip them so a user@host label never gets
      // passed to a local shell as a working directory.
      if (activeIsLocal) {
        for (const wf of workflows) {
          cmds.push({
            id: `workflow-${wf.id}`,
            label: wf.name,
            subtitle: wf.description || wf.template,
            icon: <CmdIcon d="M13 2L3 14h7l-1 8 10-12h-7z" />,
            section: t("palette.section.workflows"),
            scopes: ["action", "terminal", "workflow"],
            originalIndex: idx++,
            action: () => {
              uiStore.getState().recordCommandUse(`workflow-${wf.id}`);
              if (hasPromptableParams(wf.template)) {
                uiStore.getState().setPendingWorkflow({
                  workflowId: wf.id,
                  name: wf.name,
                  template: wf.template,
                  dir: activeSession.dir,
                  branch: activeSession.branch,
                });
              } else {
                useSessionsStore.getState().newTerminalWithInput(
                  resolveTemplate(wf.template, {}, { cwd: activeSession.dir, branch: activeSession.branch }),
                  activeSession.dir,
                );
              }
              onClose();
            },
          });
        }
      }

      // Remote sessions have no local Git working tree, so don't show the
      // current-session refresh command as a dead affordance.
      if (activeIsLocal) {
        cmds.push({
          id: "refresh-git-current",
          label: t("palette.cmd.refresh_git_current"),
          subtitle: activeSession.dir,
          icon: <CmdIcon d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />,
          section: t("palette.section.action"),
          scopes: ["action"],
          originalIndex: idx++,
          action: () => {
            uiStore.getState().recordCommandUse("refresh-git-current");
            useSessionsStore.getState().refreshGit(activeSession.id);
            onClose();
          },
        });
      }

      cmds.push({
        id: "open-session-overview",
        label: t("palette.cmd.open_session_overview"),
        icon: <CmdIcon d="M4 5h16M4 12h10M4 19h7" />,
        section: t("palette.section.action"),
        scopes: ["action", "app"],
        originalIndex: idx++,
        action: () => openInspectorTab("overview", "open-session-overview"),
      });

      cmds.push({
        id: "open-session-notes",
        label: t("palette.cmd.open_session_notes"),
        icon: <CmdIcon d="M5 4h10l4 4v12H5zM15 4v5h5M8 13h8M8 17h5" />,
        section: t("palette.section.action"),
        scopes: ["action", "app"],
        originalIndex: idx++,
        action: () => openInspectorTab("notes", "open-session-notes"),
      });

      cmds.push({
        id: activeSession.pinned ? "unpin-current-session" : "pin-current-session",
        label: activeSession.pinned ? t("palette.cmd.unpin_current_session") : t("palette.cmd.pin_current_session"),
        icon: <CmdIcon d="M12 3l3 6 6 .9-4.5 4.3 1.1 6.1L12 17.4 6.4 20.3l1.1-6.1L3 9.9 9 9z" />,
        section: t("palette.section.action"),
        scopes: ["action", "session"],
        originalIndex: idx++,
        action: () => {
          uiStore.getState().recordCommandUse(activeSession.pinned ? "unpin-current-session" : "pin-current-session");
          useSessionsStore.getState().togglePinnedSession(activeSession.id);
          onClose();
        },
      });

      cmds.push({
        id: "quick-select-visible-output",
        label: t("palette.cmd.quick_select"),
        shortcut: formatShortcut(keybindings.quickSelect),
        icon: <CmdIcon d="M9 11.5 12 14l7-8" />,
        section: t("palette.section.action"),
        scopes: ["action", "terminal"],
        originalIndex: idx++,
        action: () => {
          uiStore.getState().recordCommandUse("quick-select-visible-output");
          window.dispatchEvent(new CustomEvent(TERMINAL_QUICK_SELECT_EVENT));
          onClose();
        },
      });

      cmds.push({
        id: "rename-current-session",
        label: t("palette.cmd.rename_current_session"),
        icon: <CmdIcon d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />,
        section: t("palette.section.action"),
        scopes: ["action"],
        originalIndex: idx++,
        action: () => {
          uiStore.getState().recordCommandUse("rename-current-session");
          useSessionsStore.getState().startRenaming(activeSession.id);
          onClose();
        },
      });

      cmds.push({
        id: "close-current-session",
        label: t("palette.cmd.close_current_session"),
        shortcut: formatShortcut(keybindings.closeSession),
        icon: <CmdIcon d="M18 6 6 18M6 6l12 12" />,
        section: t("palette.section.action"),
        scopes: ["action"],
        originalIndex: idx++,
        action: () => {
          uiStore.getState().recordCommandUse("close-current-session");
          useSessionsStore.getState().closeSession(activeSession.id);
          onClose();
        },
      });
    }

    cmds.push({
      id: "toggle-sidebar",
      label: t("palette.cmd.toggle_sidebar"),
      shortcut: formatShortcut(keybindings.toggleSidebar),
      icon: <svg width={14} height={14} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}><rect x="1.5" y="1.5" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="1.2" /><rect x="1.5" y="1.5" width="4.5" height="13" rx="2" fill="currentColor" fillOpacity={0.15} /></svg>,
      section: t("palette.section.action"),
      scopes: ["action", "app"],
      originalIndex: idx++,
      action: () => { uiStore.getState().recordCommandUse("toggle-sidebar"); uiStore.getState().toggleSidebar(); onClose(); },
    });

    cmds.push({
      id: "toggle-panel",
      label: t("palette.cmd.toggle_panel"),
      shortcut: formatShortcut(keybindings.togglePanel),
      icon: <svg width={14} height={14} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}><rect x="1.5" y="1.5" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="1.2" /><rect x="9" y="1.5" width="5.5" height="13" rx="2" fill="currentColor" fillOpacity={0.15} /></svg>,
      section: t("palette.section.action"),
      scopes: ["action", "app"],
      originalIndex: idx++,
      action: () => { uiStore.getState().recordCommandUse("toggle-panel"); uiStore.getState().togglePanel(); onClose(); },
    });

    cmds.push({
      id: "workspace-insights",
      label: t("palette.cmd.workspace_insights"),
      icon: <CmdIcon d="M12 3a9 9 0 1 0 9 9M12 12l5-5" />,
      section: t("palette.section.action"),
      scopes: ["action", "app"],
      originalIndex: idx++,
      action: () => {
        uiStore.getState().recordCommandUse("workspace-insights");
        uiStore.getState().setOverlay("insights");
      },
    });

    cmds.push({
      id: "toggle-focus-mode",
      label: sidebarVisible || panelVisible ? t("palette.cmd.enter_focus") : t("palette.cmd.exit_focus"),
      icon: <CmdIcon d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
      section: t("palette.section.action"),
      scopes: ["action", "app"],
      originalIndex: idx++,
      action: () => {
        const ui = uiStore.getState();
        ui.recordCommandUse("toggle-focus-mode");
        if (ui.sidebarVisible || ui.panelVisible) {
          ui.setSidebarVisible(false);
          ui.setPanelVisible(false);
        } else {
          ui.setSidebarVisible(true);
          ui.setPanelVisible(true);
        }
        onClose();
      },
    });

    cmds.push({
      id: "split-horizontal",
      label: t("palette.cmd.split_horizontal"),
      shortcut: formatShortcut(keybindings.splitHorizontal),
      icon: <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" style={{ flexShrink: 0 }}><rect x="1.5" y="1.5" width="13" height="13" rx="2" /><line x1="8" y1="1.5" x2="8" y2="14.5" /></svg>,
      section: t("palette.section.action"),
      scopes: ["action", "terminal"],
      originalIndex: idx++,
      action: () => {
        uiStore.getState().recordCommandUse("split-horizontal");
        if (uiStore.getState().split.mode !== "single") { onClose(); return; }
        useSessionsStore.getState().splitWithNewSession("horizontal");
        onClose();
      },
    });

    cmds.push({
      id: "split-vertical",
      label: t("palette.cmd.split_vertical"),
      shortcut: formatShortcut(keybindings.splitVertical),
      icon: <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" style={{ flexShrink: 0 }}><rect x="1.5" y="1.5" width="13" height="13" rx="2" /><line x1="1.5" y1="8" x2="14.5" y2="8" /></svg>,
      section: t("palette.section.action"),
      scopes: ["action", "terminal"],
      originalIndex: idx++,
      action: () => {
        uiStore.getState().recordCommandUse("split-vertical");
        if (uiStore.getState().split.mode !== "single") { onClose(); return; }
        useSessionsStore.getState().splitWithNewSession("vertical");
        onClose();
      },
    });

    cmds.push({
      id: "settings",
      label: t("palette.cmd.settings"),
      shortcut: formatShortcut(keybindings.openSettings),
      icon: <CmdIcon d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />,
      section: t("palette.section.action"),
      scopes: ["action", "app"],
      originalIndex: idx++,
      action: () => { uiStore.getState().recordCommandUse("settings"); uiStore.getState().setOverlay("settings"); },
    });

    cmds.push({
      id: "refresh-all-git",
      label: t("palette.cmd.refresh_all_git"),
      icon: <CmdIcon d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />,
      section: t("palette.section.batch"),
      scopes: ["action", "batch"],
      originalIndex: idx++,
      action: () => {
        uiStore.getState().recordCommandUse("refresh-all-git");
        const st = useSessionsStore.getState();
        st.sessions.forEach((s) => {
          if (!s.remote) st.refreshGit(s.id);
        });
        onClose();
      },
    });

    if (sessions.length > 1) {
      cmds.push({
        id: "close-all-sessions",
        label: t("palette.cmd.close_all_sessions"),
        icon: <CmdIcon d="M18 6 6 18M6 6l12 12" />,
        section: t("palette.section.batch"),
        scopes: ["action", "batch"],
        originalIndex: idx++,
        action: () => {
          uiStore.getState().recordCommandUse("close-all-sessions");
          const st = useSessionsStore.getState();
          const closed = st.closeSessions(st.sessions.map((s) => s.id));
          if (!closed) notifyBatchCloseConfirmation(t("palette.toast.running_need_confirm"));
          onClose();
        },
      });

      cmds.push({
        id: "close-other-sessions",
        label: t("palette.cmd.close_other_sessions"),
        icon: <CmdIcon d="M18 6 6 18M6 6l12 12" />,
        section: t("palette.section.batch"),
        scopes: ["action", "batch"],
        originalIndex: idx++,
        action: () => {
          uiStore.getState().recordCommandUse("close-other-sessions");
          const st = useSessionsStore.getState();
          const closed = st.closeSessions(st.sessions.filter((s) => s.id !== activeSessionId).map((s) => s.id));
          if (!closed) notifyBatchCloseConfirmation(t("palette.toast.other_running_need_confirm"));
          onClose();
        },
      });
    }

    return cmds;
  }, [sessions, activeSessionId, activeSession, recentDirs, recentCommands, workflows, setActive, onClose, uiStore, keybindings, sidebarVisible, panelVisible, t]);

  const parsedQuery = parseCommandPaletteQuery(query);
  const filtered = filterCommandPaletteItems(commands, parsedQuery);
  const ranked = rankCommandPaletteItems(filtered, parsedQuery, usage);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    setSelectedIndex((index) => ranked.length === 0 ? 0 : Math.min(index, ranked.length - 1));
  }, [ranked.length]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const selected = el.querySelector(`[data-cmd-index="${selectedIndex}"]`) as HTMLElement | null;
    selected?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  function handleKeyDown(e: React.KeyboardEvent) {
    // 中文/日文/韩文 IME 合成期间，Arrow / Enter 应由 IME 接管，
    // 不要触发列表导航或执行命令。Escape 仍然允许关闭浮层。
    if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      if (ranked.length === 0) return;
      setSelectedIndex((i) => Math.min(i + 1, ranked.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      ranked[selectedIndex]?.action();
    }
  }

  const sections = new Map<string, Array<{ cmd: Command; globalIdx: number }>>();
  for (const [globalIdx, cmd] of ranked.entries()) {
    const list = sections.get(cmd.section) ?? [];
    list.push({ cmd, globalIdx });
    sections.set(cmd.section, list);
  }

  return (
    <>
      <div
        onClick={onClose}
        style={{
          position: "fixed", inset: 0, zIndex: 999,
          background: "var(--backdrop-color)",
          backdropFilter: "var(--backdrop-blur)",
          animation: "fadeIn var(--duration-normal) var(--ease-smooth)",
        }}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("palette.placeholder")}
        onKeyDown={handleKeyDown}
        style={{
          position: "fixed",
          top: "15%",
          left: "50%",
          transform: "translateX(-50%)",
          width: 480,
          maxWidth: "90vw",
          maxHeight: "60vh",
          background: "var(--c-bg-white)",
          border: "1px solid var(--c-border-2)",
          borderRadius: "var(--r-overlay)",
          boxShadow: "var(--shadow-overlay)",
          zIndex: 1000,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          animation: "sheetIn var(--duration-normal) var(--ease-out-back)",
        }}
      >
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--c-border-1)", display: "flex", alignItems: "center", gap: 8 }}>
          <SearchIcon size={14} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onCompositionStart={() => { composingRef.current = true; }}
            onCompositionEnd={(e) => {
              composingRef.current = false;
              // Chromium 在 compositionend 之后才同步最终值到 input.value，
              // 这里手动同步一次确保过滤命中合成完成后的字符串。
              setQuery((e.target as HTMLInputElement).value);
            }}
            aria-label={t("palette.placeholder")}
            placeholder={t("palette.placeholder")}
            style={{
              flex: 1,
              border: "none",
              background: "transparent",
              outline: "none",
              fontSize: "var(--fs-body)",
              color: "var(--c-text-primary)",
              fontFamily: "var(--font-ui)",
            }}
          />
        </div>

        <div ref={listRef} style={{ flex: 1, overflowY: "auto", padding: "6px 0" }} className="no-scrollbar scroll-fade-y">
          {ranked.length === 0 && (
            <div style={{ padding: "20px 16px", textAlign: "center", fontSize: "var(--fs-meta)", color: "var(--c-text-5)" }}>
              {t("palette.empty")}
            </div>
          )}
          {[...sections.entries()].map(([section, cmds], sectionIdx) => (
            <div key={section}>
              {sectionIdx > 0 && <div style={{ height: 1, background: "var(--c-border-1)", margin: "6px 6px" }} />}
              <div style={{ padding: "6px 20px 4px", fontSize: "var(--fs-meta)", color: "var(--c-text-4)", fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>
                {section}
              </div>
              {cmds.map(({ cmd, globalIdx }) => {
                const isSelected = globalIdx === selectedIndex;
                return (
                  <div
                    key={cmd.id}
                    data-cmd-index={globalIdx}
                    onClick={() => cmd.action()}
                    onMouseEnter={() => setSelectedIndex(globalIdx)}
                    style={{
                      position: "relative",
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "7px 14px",
                      cursor: "pointer",
                      background: isSelected ? "var(--c-accent-bg-light)" : "transparent",
                      borderRadius: "var(--r-btn)",
                      margin: "0 6px",
                      transition: "background var(--duration-fast) var(--ease-smooth), transform var(--duration-fast) var(--ease-out-expo)",
                      transform: isSelected ? "translateX(2px)" : "none",
                    }}
                  >
                    {cmd.icon && (
                      <span style={{ color: isSelected ? "var(--c-accent)" : "var(--c-text-5)", flexShrink: 0, display: "flex", transition: "color var(--duration-fast) var(--ease-smooth), transform var(--duration-fast) var(--ease-out-expo)", transform: isSelected ? "scale(1.1)" : "scale(1)" }}>
                        {cmd.icon}
                      </span>
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{
                        fontSize: "var(--fs-body)",
                        color: "var(--c-text-primary)",
                        fontWeight: 500,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}>
                        {cmd.label}
                      </div>
                      {cmd.subtitle && (
                        <div style={{
                          fontSize: "var(--fs-meta)",
                          color: "var(--c-text-5)",
                          fontFamily: "var(--font-mono)",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          marginTop: 1,
                        }}>
                          {cmd.subtitle}
                        </div>
                      )}
                    </div>
                    {cmd.shortcut && (
                      <span style={{
                        fontSize: "var(--fs-meta)",
                        color: "var(--c-text-5)",
                        fontFamily: "var(--font-mono)",
                        background: "var(--c-bg-3)",
                        padding: "1px 5px",
                        borderRadius: 4,
                        flexShrink: 0,
                      }}>
                        {cmd.shortcut}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
