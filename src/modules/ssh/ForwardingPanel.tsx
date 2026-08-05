import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useT } from "@/modules/i18n";
import {
  ForwardingCommandError,
  listDynamicForwards,
  listLocalForwards,
  startDynamicForward,
  startLocalForward,
  stopDynamicForward,
  stopLocalForward,
  type DynamicForwardView,
  type ForwardingErrorCode,
  type LocalForwardView,
} from "@/modules/ssh/forwarding-bridge";
import type { SessionBindingV1 } from "@/modules/terminal/lib/pty-bridge";
import type { Session } from "@/ui/types";
import { SessionRemediationNotice } from "@/ui/SessionRemediationNotice";

interface ForwardingPanelProps {
  binding: SessionBindingV1 | null;
  session: Session;
}

function parsePort(value: string, allowZero: boolean): number | null {
  if (!/^\d+$/.test(value)) return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port > 65_535 || (!allowZero && port === 0)) return null;
  return port;
}

export function ForwardingPanel({ binding, session }: ForwardingPanelProps) {
  const t = useT();
  const [kind, setKind] = useState<"local" | "dynamic">("local");
  const [localPort, setLocalPort] = useState("0");
  const [targetHost, setTargetHost] = useState("");
  const [targetPort, setTargetPort] = useState("");
  const [recreateOnReconnect, setRecreateOnReconnect] = useState(false);
  const [localRules, setLocalRules] = useState<LocalForwardView[]>([]);
  const [dynamicRules, setDynamicRules] = useState<DynamicForwardView[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorCode, setErrorCode] = useState<ForwardingErrorCode | null>(null);
  const bindingKey = binding
    ? `${binding.logicalSessionId}\0${binding.physicalPtyId}\0${binding.transportGeneration}`
    : "disconnected";
  const currentBindingKeyRef = useRef(bindingKey);
  currentBindingKeyRef.current = bindingKey;
  const requestEpochRef = useRef(0);
  const disposedRef = useRef(false);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
      requestEpochRef.current += 1;
    };
  }, []);

  const refresh = useCallback(async () => {
    const requestEpoch = ++requestEpochRef.current;
    const requestBindingKey = bindingKey;
    const currentRequest = () => !disposedRef.current
      && requestEpochRef.current === requestEpoch
      && currentBindingKeyRef.current === requestBindingKey;
    if (!binding) {
      if (!currentRequest()) return;
      setLocalRules([]);
      setDynamicRules([]);
      setErrorCode(null);
      setLoading(false);
      return;
    }
    if (!currentRequest()) return;
    setLoading(true);
    setErrorCode(null);
    try {
      const [local, dynamic] = await Promise.all([
        listLocalForwards(binding),
        listDynamicForwards(binding),
      ]);
      if (!currentRequest()) return;
      setLocalRules(local);
      setDynamicRules(dynamic);
    } catch (error) {
      if (!currentRequest()) return;
      setErrorCode(error instanceof ForwardingCommandError ? error.code : "internal");
    } finally {
      if (currentRequest()) setLoading(false);
    }
  }, [binding, bindingKey]);

  useEffect(() => { void refresh(); }, [refresh]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!binding) return;
    const requestedLocalPort = parsePort(localPort, true);
    const requestedTargetPort = parsePort(targetPort, false);
    if (requestedLocalPort === null || (kind === "local" && (!targetHost.trim() || requestedTargetPort === null))) {
      setErrorCode("invalidIntent");
      return;
    }
    const mutationEpoch = ++requestEpochRef.current;
    const mutationBindingKey = bindingKey;
    const currentMutation = () => !disposedRef.current
      && requestEpochRef.current === mutationEpoch
      && currentBindingKeyRef.current === mutationBindingKey;
    setLoading(true);
    setErrorCode(null);
    try {
      if (kind === "local") {
        await startLocalForward(binding, {
          localPort: requestedLocalPort,
          targetHost: targetHost.trim(),
          targetPort: requestedTargetPort!,
          recreateOnReconnect,
        });
      } else {
        await startDynamicForward(binding, { localPort: requestedLocalPort, recreateOnReconnect });
      }
      if (!currentMutation()) return;
      await refresh();
    } catch (error) {
      if (!currentMutation()) return;
      setErrorCode(error instanceof ForwardingCommandError ? error.code : "internal");
      setLoading(false);
    }
  };

  const stop = async (rule: LocalForwardView | DynamicForwardView, ruleKind: "local" | "dynamic") => {
    if (!binding) return;
    const mutationEpoch = ++requestEpochRef.current;
    const mutationBindingKey = bindingKey;
    const currentMutation = () => !disposedRef.current
      && requestEpochRef.current === mutationEpoch
      && currentBindingKeyRef.current === mutationBindingKey;
    setLoading(true);
    setErrorCode(null);
    try {
      await (ruleKind === "local"
        ? stopLocalForward(binding, rule.ruleId)
        : stopDynamicForward(binding, rule.ruleId));
      if (!currentMutation()) return;
      await refresh();
    } catch (error) {
      if (!currentMutation()) return;
      setErrorCode(error instanceof ForwardingCommandError ? error.code : "internal");
      setLoading(false);
    }
  };

  const phase = session.connection?.phase;
  return (
    <section aria-labelledby="forwarding-title" style={{ padding: 12, overflow: "auto" }}>
      <h2 id="forwarding-title" style={{ marginTop: 0 }}>{t("forwarding.title")}</h2>
      <p style={{ color: "var(--c-text-4)", fontSize: "var(--fs-secondary)" }}>{t("forwarding.loopback_only")}</p>
      {(phase === "reconnecting" || phase === "needsUserAction") && (
        <div role={phase === "needsUserAction" ? "alert" : "status"} style={{ padding: 8, border: "1px solid var(--c-border-2)", borderRadius: "var(--r-card)", marginBottom: 12 }}>
          <strong>{t(phase === "reconnecting" ? "forwarding.reconnecting" : "forwarding.needs_action")}</strong>
          <div>{t("forwarding.replacement_shell")}</div>
          {phase === "needsUserAction" && <SessionRemediationNotice session={session} compact />}
        </div>
      )}
      {!binding && <p role="status">{t("forwarding.unavailable")}</p>}
      {binding && (
        <form onSubmit={(event) => { void submit(event); }} style={{ display: "grid", gap: 8, marginBottom: 16 }}>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend>{t("forwarding.kind")}</legend>
            <label><input type="radio" name="forward-kind" checked={kind === "local"} onChange={() => setKind("local")} /> {t("forwarding.local")}</label>{" "}
            <label><input type="radio" name="forward-kind" checked={kind === "dynamic"} onChange={() => setKind("dynamic")} /> {t("forwarding.dynamic")}</label>
          </fieldset>
          <label>{t("forwarding.local_port")} <input inputMode="numeric" value={localPort} onChange={(event) => setLocalPort(event.target.value)} aria-describedby="forwarding-port-hint" /></label>
          <span id="forwarding-port-hint" style={{ color: "var(--c-text-5)", fontSize: "var(--fs-meta)" }}>{t("forwarding.port_hint")}</span>
          {kind === "local" && (
            <>
              <label>{t("forwarding.target_host")} <input value={targetHost} onChange={(event) => setTargetHost(event.target.value)} /></label>
              <label>{t("forwarding.target_port")} <input inputMode="numeric" value={targetPort} onChange={(event) => setTargetPort(event.target.value)} /></label>
            </>
          )}
          <label><input type="checkbox" checked={recreateOnReconnect} onChange={(event) => setRecreateOnReconnect(event.target.checked)} /> {t("forwarding.recreate")}</label>
          <button type="submit" disabled={loading}>{t("forwarding.start")}</button>
        </form>
      )}
      {errorCode && <div role="alert">{t(`forwarding.error.${errorCode}`)}</div>}
      {loading && <div role="status">{t("forwarding.loading")}</div>}
      <button type="button" onClick={() => { void refresh(); }} disabled={!binding || loading}>{t("forwarding.refresh")}</button>
      <h3>{t("forwarding.active")}</h3>
      {localRules.length + dynamicRules.length === 0 && !loading && <p>{t("forwarding.empty")}</p>}
      <ul>
        {localRules.map((rule) => (
          <li key={rule.ruleId}>
            <strong>{t("forwarding.local")}</strong>{" "}
            <code>{rule.bindHost}:{rule.localPort} → {rule.targetHost}:{rule.targetPort}</code>{" "}
            <span>{rule.requestedLocalPort === 0 ? t("forwarding.ephemeral") : t("forwarding.requested", { port: rule.requestedLocalPort })}</span>{" "}
            {rule.recreateOnReconnect && <span>{t("forwarding.recreate_badge")}</span>}{" "}
            <button type="button" onClick={() => { void stop(rule, "local"); }} disabled={loading}>{t("forwarding.stop")}</button>
          </li>
        ))}
        {dynamicRules.map((rule) => (
          <li key={rule.ruleId}>
            <strong>{t("forwarding.dynamic")}</strong>{" "}
            <code>SOCKS5 {rule.bindHost}:{rule.localPort}</code>{" "}
            <span>{rule.requestedLocalPort === 0 ? t("forwarding.ephemeral") : t("forwarding.requested", { port: rule.requestedLocalPort })}</span>{" "}
            {rule.recreateOnReconnect && <span>{t("forwarding.recreate_badge")}</span>}{" "}
            <button type="button" onClick={() => { void stop(rule, "dynamic"); }} disabled={loading}>{t("forwarding.stop")}</button>
          </li>
        ))}
      </ul>
    </section>
  );
}
