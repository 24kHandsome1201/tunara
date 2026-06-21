import { useEffect, useState } from "react";
import { fsReadDir, type DirEntry } from "@/modules/fs/fs-bridge";
import { formatSize } from "./types";
import { FilePreview } from "./FilePreview";

interface FileExplorerProps {
  rootDir: string;
}

function FolderIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--c-accent)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--c-text-5)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}


function pathDisplay(currentPath: string, rootDir: string): string {
  const resolved = rootDir === "~" ? currentPath : currentPath;
  const parts = resolved.split("/").filter(Boolean);
  if (parts.length <= 3) return parts.join(" / ");
  return "… / " + parts.slice(-3).join(" / ");
}

export function FileExplorer({ rootDir }: FileExplorerProps) {
  const [currentPath, setCurrentPath] = useState(rootDir);
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [expandedFile, setExpandedFile] = useState<string | null>(null);

  useEffect(() => {
    setCurrentPath(rootDir);
  }, [rootDir]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    setExpandedFile(null);
    fsReadDir(currentPath)
      .then((e) => { if (!cancelled) { setEntries(e); setLoading(false); } })
      .catch(() => { if (!cancelled) { setEntries([]); setError(true); setLoading(false); } });
    return () => { cancelled = true; };
  }, [currentPath]);

  const canGoUp = currentPath !== "/" && currentPath !== rootDir;

  function goUp() {
    const parts = currentPath.split("/");
    parts.pop();
    const parent = parts.join("/") || "/";
    setCurrentPath(parent);
  }

  function enterDir(name: string) {
    const next = currentPath.endsWith("/") ? currentPath + name : currentPath + "/" + name;
    setCurrentPath(next);
  }

  function toggleFile(name: string) {
    const fullPath = currentPath.endsWith("/") ? currentPath + name : currentPath + "/" + name;
    setExpandedFile((prev) => (prev === fullPath ? null : fullPath));
  }

  const dirs = entries.filter((e) => e.kind === "dir");
  const files = entries.filter((e) => e.kind !== "dir");

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      {/* breadcrumb */}
      <div style={{ height: 34, borderBottom: "1px solid var(--c-border-1)", display: "flex", alignItems: "center", padding: "0 8px 0 6px", gap: 6, flexShrink: 0 }}>
        <button
          onClick={goUp}
          disabled={!canGoUp}
          className="hover-bg"
          style={{
            width: 22, height: 22, borderRadius: "var(--r-btn)", border: "none",
            background: "transparent", cursor: canGoUp ? "pointer" : "default",
            display: "flex", alignItems: "center", justifyContent: "center",
            opacity: canGoUp ? 1 : 0.3, flexShrink: 0,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span style={{ fontSize: "var(--fs-meta)", fontFamily: "var(--font-mono)", color: "var(--c-text-4)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", direction: "rtl", textAlign: "left", flex: 1 }}>
          {pathDisplay(currentPath, rootDir)}
        </span>
      </div>

      {/* content */}
      <div style={{ flex: 1, overflowY: "auto", padding: "6px 8px" }} className="no-scrollbar">
        {loading ? (
          <div style={{ padding: "28px 14px", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--c-text-5)", animation: "pulseDot 1.2s ease infinite" }} />
            <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)" }}>加载中</span>
          </div>
        ) : error ? (
          <div style={{ padding: "28px 14px", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
            <div style={{ width: 36, height: 36, borderRadius: "50%", background: "var(--c-bg-3)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--c-text-5)" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" />
              </svg>
            </div>
            <span style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-4)" }}>无法读取目录</span>
          </div>
        ) : entries.length === 0 ? (
          <div style={{ padding: "28px 14px", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
            <div style={{ width: 36, height: 36, borderRadius: "50%", background: "var(--c-bg-3)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--c-text-5)" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <span style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-4)" }}>目录为空</span>
          </div>
        ) : (
          <>
            {dirs.map((entry) => (
              <button
                key={"d-" + entry.name}
                onClick={() => enterDir(entry.name)}
                className="hover-bg"
                style={{ width: "100%", height: 30, padding: "0 8px", borderRadius: "var(--r-btn)", border: "none", background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", gap: 6, textAlign: "left", marginBottom: 2 }}
              >
                <FolderIcon />
                <span style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-2)", fontWeight: 500, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.name}</span>
                <span style={{ fontSize: 10, color: "var(--c-text-6)", flexShrink: 0 }}>›</span>
              </button>
            ))}

            {dirs.length > 0 && files.length > 0 && (
              <div style={{ borderTop: "1px solid var(--c-border-2)", margin: "4px 0" }} />
            )}

            {files.map((entry) => {
              const fullPath = currentPath.endsWith("/") ? currentPath + entry.name : currentPath + "/" + entry.name;
              const isExpanded = expandedFile === fullPath;
              return (
                <div key={"f-" + entry.name}>
                  <button
                    onClick={() => toggleFile(entry.name)}
                    className="hover-bg"
                    style={{
                      width: "100%", height: 30, padding: "0 8px", borderRadius: "var(--r-btn)", border: "none",
                      background: isExpanded ? "var(--c-accent-bg-light)" : "transparent",
                      cursor: "pointer", display: "flex", alignItems: "center", gap: 6, textAlign: "left", marginBottom: 2,
                    }}
                  >
                    <FileIcon />
                    <span style={{ fontSize: "var(--fs-secondary)", color: isExpanded ? "var(--c-text-primary)" : "var(--c-text-2)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: "var(--font-mono)" }}>{entry.name}</span>
                    <span style={{ fontSize: "var(--fs-meta)", color: "var(--c-text-5)", fontFamily: "var(--font-mono)", flexShrink: 0 }}>{formatSize(entry.size)}</span>
                  </button>
                  {isExpanded && (
                    <FilePreview filePath={fullPath} fileName={entry.name} onClose={() => setExpandedFile(null)} />
                  )}
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}
