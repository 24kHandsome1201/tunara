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
  action: () => void;
  section: string;
}

export function CommandPalette({ onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const sessions = useSessionsStore((s) => s.sessions);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const setActive = useSessionsStore((s) => s.setActive);
  const ui = useUIStore;

  const commands = useMemo((): Command[] => {
    const cmds: Command[] = [];

    sessions
      .filter((s: Session) => s.id !== activeSessionId)
      .forEach((s: Session) => {
        const { primary, subtitle } = deriveTitle(s);
        cmds.push({
          id: `switch-${s.id}`,
          label: primary,
          subtitle,
          section: "会话",
          action: () => { setActive(s.id); onClose(); },
        });
      });

    cmds.push({
      id: "new-terminal",
      label: "新建终端",
      shortcut: "⌘T",
      section: "操作",
      action: () => {
        useSessionsStore.getState().newTerminal();
        onClose();
      },
    });

    cmds.push({
      id: "toggle-sidebar",
      label: "切换侧栏",
      shortcut: "⌘\\",
      section: "操作",
      action: () => { ui.getState().toggleSidebar(); onClose(); },
    });

    cmds.push({
      id: "toggle-panel",
      label: "切换审查面板",
      shortcut: "⌘⇧\\",
      section: "操作",
      action: () => { ui.getState().togglePanel(); onClose(); },
    });

    cmds.push({
      id: "split-horizontal",
      label: "水平分栏",
      shortcut: "⌘D",
      section: "操作",
      action: () => {
        if (ui.getState().split.mode !== "single") { onClose(); return; }
        useSessionsStore.getState().splitWithNewSession("horizontal");
        onClose();
      },
    });

    cmds.push({
      id: "split-vertical",
      label: "垂直分栏",
      shortcut: "⌘⇧D",
      section: "操作",
      action: () => {
        if (ui.getState().split.mode !== "single") { onClose(); return; }
        useSessionsStore.getState().splitWithNewSession("vertical");
        onClose();
      },
    });

    cmds.push({
      id: "settings",
      label: "设置",
      shortcut: "⌘,",
      section: "操作",
      action: () => { ui.getState().setOverlay("settings"); },
    });

    return cmds;
  }, [sessions, activeSessionId, setActive, onClose, ui]);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? commands.filter((c) =>
        c.label.toLowerCase().includes(q) ||
        c.subtitle?.toLowerCase().includes(q) ||
        c.section.toLowerCase().includes(q))
    : commands;

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const selected = el.children[selectedIndex] as HTMLElement | undefined;
    selected?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      filtered[selectedIndex]?.action();
    }
  }

  const sections = new Map<string, Command[]>();
  for (const cmd of filtered) {
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
        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--c-border-1)" }}>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="输入命令或搜索…"
            style={{
              width: "100%",
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
          {filtered.length === 0 && (
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
                const globalIdx = filtered.indexOf(cmd);
                const isSelected = globalIdx === selectedIndex;
                return (
                  <div
                    key={cmd.id}
                    onClick={() => cmd.action()}
                    onMouseEnter={() => setSelectedIndex(globalIdx)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      padding: "7px 16px",
                      cursor: "pointer",
                      background: isSelected ? "var(--c-bg-hover)" : "transparent",
                      borderRadius: "var(--r-badge)",
                      margin: "0 6px",
                    }}
                  >
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
