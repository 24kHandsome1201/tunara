import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionBindingV1 } from "@/modules/terminal/lib/pty-bridge";
import { performRemoteChmod } from "./actions";
import {
  sshStatV1,
  type ChmodResultV1,
  type RemoteMetadataV1,
} from "./bridge";

export function formatRemoteMode(mode: number): { rwx: string; octal: string; special: string } {
  const permissions = mode & 0o777;
  const chars = [
    [0o400, "r"], [0o200, "w"], [0o100, "x"],
    [0o040, "r"], [0o020, "w"], [0o010, "x"],
    [0o004, "r"], [0o002, "w"], [0o001, "x"],
  ] as const;
  return {
    rwx: chars.map(([bit, char]) => permissions & bit ? char : "-").join(""),
    octal: permissions.toString(8).padStart(4, "0"),
    special: (mode & 0o7000).toString(8).padStart(4, "0"),
  };
}

function owner(metadata: RemoteMetadataV1): string {
  const user = metadata.user ?? (metadata.uid === undefined ? "unknown" : String(metadata.uid));
  const group = metadata.group ?? (metadata.gid === undefined ? "unknown" : String(metadata.gid));
  return `${user}:${group}`;
}

export interface RemoteMetadataPanelProps {
  binding: SessionBindingV1;
  path: string;
  host: string;
}

export function RemoteMetadataPanel({ binding, path, host }: RemoteMetadataPanelProps) {
  const targetKey = `${binding.logicalSessionId}\0${binding.physicalPtyId}\0${binding.transportGeneration}\0${path}`;
  const currentTargetKey = useRef(targetKey);
  currentTargetKey.current = targetKey;
  const [loaded, setLoaded] = useState<{ key: string; value: RemoteMetadataV1 } | null>(null);
  const [modeInput, setModeInput] = useState("");
  const [result, setResult] = useState<{ key: string; value: ChmodResultV1 } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    setLoaded(null);
    setResult(null);
    setError("");
    void sshStatV1(binding, path).then((next) => {
      if (!current || currentTargetKey.current !== targetKey) return;
      setLoaded({ key: targetKey, value: next });
      setModeInput(next.mode === undefined ? "" : (next.mode & 0o777).toString(8).padStart(4, "0"));
    }).catch((caught) => {
      if (current && currentTargetKey.current === targetKey) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    });
    return () => { current = false; };
  }, [binding, path, targetKey]);

  const metadata = loaded?.key === targetKey ? loaded.value : null;
  const activeResult = result?.key === targetKey ? result.value : null;

  const parsedMode = useMemo(
    () => /^[0-7]{4}$/.test(modeInput) ? Number.parseInt(modeInput, 8) : null,
    [modeInput],
  );
  const formatted = metadata?.mode === undefined ? null : formatRemoteMode(metadata.mode);
  const canChmod = metadata !== null
    && metadata.capability.chmod === "supported"
    && metadata.kind !== "symlink"
    && metadata.kind !== "other"
    && metadata.parentPrecondition !== undefined
    && parsedMode !== null;

  const chmod = async () => {
    if (!metadata || !metadata.parentPrecondition || parsedMode === null || busy) return;
    const submittedTarget = targetKey;
    setBusy(true);
    setError("");
    try {
      const next = await performRemoteChmod({
        operationId: crypto.randomUUID(),
        binding,
        path,
        mode: parsedMode,
        expected: metadata.precondition,
        expectedParent: metadata.parentPrecondition,
      });
      if (currentTargetKey.current !== submittedTarget) return;
      setResult({ key: submittedTarget, value: next });
      const refreshed = await sshStatV1(binding, path);
      if (currentTargetKey.current !== submittedTarget) return;
      setLoaded({ key: submittedTarget, value: refreshed });
      setModeInput(refreshed.mode === undefined ? "" : (refreshed.mode & 0o777).toString(8).padStart(4, "0"));
    } catch (caught) {
      if (currentTargetKey.current === submittedTarget) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="remote-metadata-title" style={{ display: "grid", gap: 12 }}>
      <h2 id="remote-metadata-title">Remote metadata</h2>
      <div><strong>Host:</strong> {host}</div>
      <div style={{ overflowWrap: "anywhere" }}><strong>Path:</strong> <code>{path}</code></div>
      {!metadata && !error && <div role="status">Loading metadata…</div>}
      {metadata && (
        <>
          <dl style={{ display: "grid", gridTemplateColumns: "110px 1fr", gap: 8, margin: 0 }}>
            <dt>Kind</dt><dd style={{ margin: 0 }}>{metadata.kind}</dd>
            <dt>Permissions</dt><dd style={{ margin: 0 }}>{formatted ? `${formatted.rwx} (${formatted.octal})` : "unknown"}</dd>
            <dt>Owner/group</dt><dd style={{ margin: 0 }}>{owner(metadata)}</dd>
            {metadata.linkTarget !== undefined && <><dt>Symlink target</dt><dd style={{ margin: 0, overflowWrap: "anywhere" }}>{metadata.linkTarget}</dd></>}
            {formatted && formatted.special !== "0000" && <><dt>Special bits</dt><dd style={{ margin: 0 }}>{formatted.special} (read-only)</dd></>}
          </dl>
          <label>
            Permissions (0000–0777)
            <input
              className="ui-control"
              aria-label="Permissions (0000–0777)"
              value={modeInput}
              onChange={(event) => setModeInput(event.target.value)}
              inputMode="numeric"
              pattern="[0-7]{4}"
              disabled={metadata.capability.chmod !== "supported" || metadata.kind === "symlink" || busy}
            />
          </label>
          {metadata.kind === "symlink" && <p>chmod is unavailable because lstat observed a symlink.</p>}
          {metadata.kind !== "symlink" && metadata.capability.chmod === "unsupported" && (
            <p>chmod is unavailable because this SFTP connection cannot prove a no-follow, identity-bound update.</p>
          )}
          <button type="button" className="ui-button ui-button--primary" disabled={!canChmod || busy} onClick={() => { void chmod(); }}>
            {busy ? "Checking…" : "Apply permissions"}
          </button>
          <p>Capability: chmod {metadata.capability.chmod}; handle SETSTAT {metadata.capability.handleSetstat}; posix rename {metadata.capability.posixRename}.</p>
        </>
      )}
      {activeResult && <div role="status">{activeResult.status}: {activeResult.message}<br />{activeResult.toctouBoundary}</div>}
      {error && <div role="alert">{error}</div>}
    </section>
  );
}
