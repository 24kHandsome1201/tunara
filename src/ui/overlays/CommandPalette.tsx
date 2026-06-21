import { useEffect, useRef, useState, useMemo } from "react";
import { deriveTitle, type Session } from "../types";
import { useSessionsStore } from "@/state/sessions";
import { useUIStore } from "@/state/ui";

interface CommandPaletteProps {
  onClose: () => void;
}

interface Command {
  id: string;
  label: string;
  subtitle?: string;
  shortcut?: string;
  icon?: React.ReactNode;
  action: () => void;
  section: string;
  originalIndex: number;
}

function CmdIcon({ d, size = 14 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d={d} />
    </svg>
  );
}

export function CommandPalette({ onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const sessions = useSessionsStore((s) => s.sessions);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const setActive = useSessionsStore((s) => s.setActive);
  const activeSession = sessions.find((s) => s.id === activeSessionId) ?? null;
  const ui = useUIStore;
  const usage = useUIStore((s) => s.commandUsage);

  const commands = useMemo((): Command[] => {
    const cmds: Command[] = [];
    let idx = 0;

    sessions
      .filter((s: Session) => s.id !== activeSessionId)
      .forEach((s: Session) => {
        const { primary, subtitle } = deriveTitle(s);
        cmds.push({
          id: `switch-${s.id}`,
          label: primary,
          subtitle,
          icon: <CmdIcon d="M4 17l6-6-6-6M12 19h8" />,
          section: "会话",
          originalIndex: idx++,
          action: () => { setActive(s.id); ui.getState().recordCommandUse(`switch-${s.id}`); onClose(); },
        });
      });

    cmds.push({
      id: "new-terminal",
      label: "新建终端",
      shortcut: "⌘T",
      icon: <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>,
      section: "操作",
      originalIndex: idx++,
      action: () => {
        ui.getState().recordCommandUse("new-terminal");
        useSessionsStore.getState().newTerminal();
        onClose();
      },
    });

    if (activeSession) {
      cmds.push({
        id: "new-terminal-current-dir",
        label: "在当前目录新建终端",
        subtitle: activeSession.dir,
        icon: <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M12 5v14M5 12h14" /><path d="M3 6h6l2 2h10v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>,
        section: "操作",
        originalIndex: idx++,
        action: () => {
          ui.getState().recordCommandUse("new-terminal-current-dir");
          useSessionsStore.getState().newTerminalInDir(activeSession.dir);
          onClose();
        },
      });

      cmds.push({
        id: "refresh-git-current",
        label: "刷新当前 Git 状态",
        subtitle: activeSession.dir,
        icon: <CmdIcon d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />,
        section: "操作",
        originalIndex: idx++,
        action: () => {
          ui.getState().recordCommandUse("refresh-git-current");
          useSessionsStore.getState().refreshGit(activeSession.id);
          onClose();
        },
      });

      cmds.push({
        id: "rename-current-session",
        label: "重命名当前会话",
        icon: <CmdIcon d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />,
        section: "操作",
        originalIndex: idx++,
        action: () => {
          ui.getState().recordCommandUse("rename-current-session");
          useSessionsStore.getState().startRenaming(activeSession.id);
          onClose();
        },
      });

      cmds.push({
        id: "close-current-session",
        label: "关闭当前会话",
        shortcut: "⌘W",
        icon: <CmdIcon d="M18 6 6 18M6 6l12 12" />,
        section: "操作",
        originalIndex: idx++,
        action: () => {
          ui.getState().recordCommandUse("close-current-session");
          useSessionsStore.getState().closeSession(activeSession.id);
          onClose();
        },
      });
    }

    cmds.push({
      id: "toggle-sidebar",
      label: "切换侧栏",
      shortcut: "⌘\\",
      icon: <svg width={14} height={14} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}><rect x="1.5" y="1.5" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="1.2" /><rect x="1.5" y="1.5" width="4.5" height="13" rx="2" fill="currentColor" fillOpacity={0.15} /></svg>,
      section: "操作",
      originalIndex: idx++,
      action: () => { ui.getState().recordCommandUse("toggle-sidebar"); ui.getState().toggleSidebar(); onClose(); },
    });

    cmds.push({
      id: "toggle-panel",
      label: "切换审查面板",
      shortcut: "⌘⇧\\",
      icon: <svg width={14} height={14} viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}><rect x="1.5" y="1.5" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="1.2" /><rect x="9" y="1.5" width="5.5" height="13" rx="2" fill="currentColor" fillOpacity={0.15} /></svg>,
      section: "操作",
      originalIndex: idx++,
      action: () => { ui.getState().recordCommandUse("toggle-panel"); ui.getState().togglePanel(); onClose(); },
    });

    cmds.push({
      id: "split-horizontal",
      label: "水平分栏",
      shortcut: "⌘D",
      icon: <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" style={{ flexShrink: 0 }}><rect x="1.5" y="1.5" width="13" height="13" rx="2" /><line x1="8" y1="1.5" x2="8" y2="14.5" /></svg>,
      section: "操作",
      originalIndex: idx++,
      action: () => {
        ui.getState().recordCommandUse("split-horizontal");
        if (ui.getState().split.mode !== "single") { onClose(); return; }
        useSessionsStore.getState().splitWithNewSession("horizontal");
        onClose();
      },
    });

    cmds.push({
      id: "split-vertical",
      label: "垂直分栏",
      shortcut: "⌘⇧D",
      icon: <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" style={{ flexShrink: 0 }}><rect x="1.5" y="1.5" width="13" height="13" rx="2" /><line x1="1.5" y1="8" x2="14.5" y2="8" /></svg>,
      section: "操作",
      originalIndex: idx++,
      action: () => {
        ui.getState().recordCommandUse("split-vertical");
        if (ui.getState().split.mode !== "single") { onClose(); return; }
        useSessionsStore.getState().splitWithNewSession("vertical");
        onClose();
      },
    });

    cmds.push({
      id: "settings",
      label: "设置",
      shortcut: "⌘,",
      icon: <CmdIcon d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />,
      section: "操作",
      originalIndex: idx++,
      action: () => { ui.getState().recordCommandUse("settings"); ui.getState().setOverlay("settings"); },
    });

    cmds.push({
      id: "refresh-all-git",
      label: "刷新所有 Git 状态",
      icon: <CmdIcon d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />,
      section: "批量",
      originalIndex: idx++,
      action: () => {
        ui.getState().recordCommandUse("refresh-all-git");
        const st = useSessionsStore.getState();
        st.sessions.forEach((s) => st.refreshGit(s.id));
        onClose();
      },
    });

    if (sessions.length > 1) {
      cmds.push({
        id: "close-all-sessions",
        label: "关闭所有会话",
        icon: <CmdIcon d="M18 6 6 18M6 6l12 12" />,
        section: "批量",
        originalIndex: idx++,
        action: () => {
          ui.getState().recordCommandUse("close-all-sessions");
          const st = useSessionsStore.getState();
          [...st.sessions].reverse().forEach((s) => st.closeSession(s.id));
          onClose();
        },
      });

      cmds.push({
        id: "close-other-sessions",
        label: "关闭其他会话",
        icon: <CmdIcon d="M18 6 6 18M6 6l12 12" />,
        section: "批量",
        originalIndex: idx++,
        action: () => {
          ui.getState().recordCommandUse("close-other-sessions");
          const st = useSessionsStore.getState();
          st.sessions.filter((s) => s.id !== activeSessionId).reverse().forEach((s) => st.closeSession(s.id));
          onClose();
        },
      });
    }

    return cmds;
  }, [sessions, activeSessionId, activeSession, setActive, onClose, ui]);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? commands.filter((c) =>
        c.label.toLowerCase().includes(q) ||
        c.subtitle?.toLowerCase().includes(q) ||
        c.section.toLowerCase().includes(q))
    : commands;

  const ranked = [...filtered].sort((a, b) => {
    if (q) {
      const ia = a.label.toLowerCase().indexOf(q);
      const ib = b.label.toLowerCase().indexOf(q);
      if (ia !== ib) return ia - ib;
    }
    const ua = usage[a.id] ?? 0;
    const ub = usage[b.id] ?? 0;
    if (ua !== ub) return ub - ua;
    return a.originalIndex - b.originalIndex;
  });

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

  const sections = new Map<string, Command[]>();
  for (const cmd of ranked) {
    const list = sections.get(cmd.section) ?? [];
    list.push(cmd);
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
          animation: "fadeIn var(--duration-fast) ease",
        }}
      />
      <div
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
          animation: "sheetIn var(--duration-normal) ease",
        }}
      >
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--c-border-1)", display: "flex", alignItems: "center", gap: 8 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--c-text-5)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="输入命令或搜索…"
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

        <div ref={listRef} style={{ flex: 1, overflowY: "auto", padding: "6px 0" }} className="no-scrollbar">
          {ranked.length === 0 && (
            <div style={{ padding: "20px 16px", textAlign: "center", fontSize: "var(--fs-meta)", color: "var(--c-text-5)" }}>
              无匹配结果
            </div>
          )}
          {[...sections.entries()].map(([section, cmds]) => (
            <div key={section}>
              <div style={{ padding: "6px 16px 4px", fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontWeight: 600 }}>
                {section}
              </div>
              {cmds.map((cmd) => {
                const globalIdx = ranked.indexOf(cmd);
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
                      padding: "7px 12px 7px 14px",
                      cursor: "pointer",
                      background: isSelected ? "var(--c-accent-bg-soft)" : "transparent",
                      borderRadius: "var(--r-btn)",
                      margin: "0 6px",
                      transition: "background var(--duration-fast) ease",
                    }}
                  >
                    {isSelected && (
                      <div style={{
                        position: "absolute",
                        left: 0,
                        top: "50%",
                        transform: "translateY(-50%)",
                        width: 3,
                        height: "60%",
                        background: "var(--c-accent)",
                        borderRadius: "0 2px 2px 0",
                      }} />
                    )}
                    {cmd.icon && (
                      <span style={{ color: isSelected ? "var(--c-accent)" : "var(--c-text-5)", flexShrink: 0, display: "flex", transition: "color var(--duration-fast) ease" }}>
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
