import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useT } from "@/modules/i18n";
import {
  ForwardingCommandError,
  listDynamicForwards,
  listLocalForwards,
  listRemoteForwards,
  startDynamicForward,
  startLocalForward,
  startRemoteForward,
  stopDynamicForward,
  stopLocalForward,
  stopRemoteForward,
  type DynamicForwardView,
  type ForwardingErrorCode,
  type LocalForwardView,
  type RemoteForwardView,
} from "@/modules/ssh/forwarding-bridge";
import type { SessionBindingV1 } from "@/modules/terminal/lib/pty-bridge";
import type { Session } from "@/ui/types";
import { SessionRemediationNotice } from "@/ui/SessionRemediationNotice";
import { copyText } from "@/ui/lib/clipboard";
import { PanelActionButton, PanelToolbar } from "@/ui/shared";
import { useUIStore } from "@/state/ui";

interface ForwardingPanelProps {
  binding: SessionBindingV1 | null;
  session: Session;
}

type FieldKey = "localPort" | "targetHost" | "targetPort";

function parsePort(value: string, allowZero: boolean): number | null {
  if (!/^\d+$/.test(value)) return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port > 65_535 || (!allowZero && port === 0)) return null;
  return port;
}

export function ForwardingPanel({ binding, session }: ForwardingPanelProps) {
  const t = useT();
  const [kind, setKind] = useState<"local" | "dynamic" | "remote">("local");
  const [localPort, setLocalPort] = useState("0");
  const [targetHost, setTargetHost] = useState("");
  const [targetPort, setTargetPort] = useState("");
  const [recreateOnReconnect, setRecreateOnReconnect] = useState(false);
  const [localRules, setLocalRules] = useState<LocalForwardView[]>([]);
  const [dynamicRules, setDynamicRules] = useState<DynamicForwardView[]>([]);
  const [remoteRules, setRemoteRules] = useState<RemoteForwardView[]>([]);
  const [loading, setLoading] = useState(false);
  const [errorCode, setErrorCode] = useState<ForwardingErrorCode | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FieldKey, boolean>>>({});
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
      setRemoteRules([]);
      setErrorCode(null);
      setLoading(false);
      return;
    }
    if (!currentRequest()) return;
    setLoading(true);
    setErrorCode(null);
    try {
      const [local, dynamic, remote] = await Promise.all([
        listLocalForwards(binding),
        listDynamicForwards(binding),
        listRemoteForwards(binding),
      ]);
      if (!currentRequest()) return;
      setLocalRules(local);
      setDynamicRules(dynamic);
      setRemoteRules(remote);
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
    const nextFields: Partial<Record<FieldKey, boolean>> = {};
    if (requestedLocalPort === null) nextFields.localPort = true;
    if (kind === "local" && !targetHost.trim()) nextFields.targetHost = true;
    if ((kind === "local" || kind === "remote") && requestedTargetPort === null) nextFields.targetPort = true;
    if (Object.keys(nextFields).length > 0) {
      setFieldErrors(nextFields);
      setErrorCode(null);
      return;
    }
    setFieldErrors({});
    if (requestedLocalPort === null) return;
    if (kind !== "dynamic" && requestedTargetPort === null) return;
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
      } else if (kind === "remote") {
        await startRemoteForward(binding, {
          remotePort: requestedLocalPort,
          localTargetPort: requestedTargetPort!,
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

  const stop = async (rule: LocalForwardView | DynamicForwardView | RemoteForwardView, ruleKind: "local" | "dynamic" | "remote") => {
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
        : ruleKind === "remote"
          ? stopRemoteForward(binding, rule.ruleId)
          : stopDynamicForward(binding, rule.ruleId));
      if (!currentMutation()) return;
      await refresh();
    } catch (error) {
      if (!currentMutation()) return;
      setErrorCode(error instanceof ForwardingCommandError ? error.code : "internal");
      setLoading(false);
    }
  };

  const copyEndpoint = async (endpoint: string) => {
    const copied = await copyText(endpoint);
    useUIStore.getState().addToast({
      sessionId: session.id,
      title: t(copied ? "clipboard.copy_success" : "clipboard.copy_failed"),
      subtitle: endpoint,
      variant: copied ? "success" : "error",
    });
  };

  const phase = session.connection?.phase;
  const fieldAlert = (key: FieldKey, messageKey: string) => fieldErrors[key]
    ? <div role="alert" style={{ color: "var(--c-error)", fontSize: "var(--fs-meta)" }}>{t(messageKey)}</div>
    : null;
  return (
    <section aria-labelledby="forwarding-title" style={{ minHeight: 0, display: "flex", flexDirection: "column", overflow: "auto" }}>
      <PanelToolbar titleId="forwarding-title" title={t("forwarding.title")}>
        <PanelActionButton onClick={() => { void refresh(); }} disabled={!binding || loading}>{t("forwarding.refresh")}</PanelActionButton>
      </PanelToolbar>
      <div style={{ padding: 12, display: "grid", gap: 12 }}>
      <p style={{ color: "var(--c-text-4)", fontSize: "var(--fs-secondary)", margin: 0 }}>{t("forwarding.loopback_only")}</p>
      {(phase === "reconnecting" || phase === "needsUserAction") && (
        <div role={phase === "needsUserAction" ? "alert" : "status"} style={{ padding: 8, border: "1px solid var(--c-border-2)", borderRadius: "var(--r-card)" }}>
          <strong>{t(phase === "reconnecting" ? "forwarding.reconnecting" : "forwarding.needs_action")}</strong>
          <div>{t("forwarding.replacement_shell")}</div>
          {phase === "needsUserAction" && <SessionRemediationNotice session={session} compact />}
        </div>
      )}
      {!binding && <p role="status">{t("forwarding.unavailable")}</p>}
      {binding && (
        <form onSubmit={(event) => { void submit(event); }} style={{ display: "grid", gap: 8 }}>
          <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
            <legend>{t("forwarding.kind")}</legend>
            <label><input className="ui-choice" type="radio" name="forward-kind" checked={kind === "local"} onChange={() => setKind("local")} /> {t("forwarding.local")}</label>{" "}
            <label><input className="ui-choice" type="radio" name="forward-kind" checked={kind === "dynamic"} onChange={() => setKind("dynamic")} /> {t("forwarding.dynamic")}</label>{" "}
            <label><input className="ui-choice" type="radio" name="forward-kind" checked={kind === "remote"} onChange={() => setKind("remote")} /> {t("forwarding.remote")}</label>
          </fieldset>
          <label>{kind === "remote" ? t("forwarding.remote_port") : t("forwarding.local_port")} <input className="ui-control" inputMode="numeric" value={localPort} onChange={(event) => { setLocalPort(event.target.value); setFieldErrors((current) => ({ ...current, localPort: false })); }} aria-invalid={fieldErrors.localPort ? "true" : undefined} aria-describedby="forwarding-port-hint" /></label>
          {fieldAlert("localPort", "forwarding.field.invalid_port")}
          <span id="forwarding-port-hint" style={{ color: "var(--c-text-5)", fontSize: "var(--fs-meta)" }}>{t(kind === "remote" ? "forwarding.remote_port_hint" : "forwarding.port_hint")}</span>
          {kind === "local" && (
            <>
              <label>{t("forwarding.target_host")} <input className="ui-control" value={targetHost} onChange={(event) => { setTargetHost(event.target.value); setFieldErrors((current) => ({ ...current, targetHost: false })); }} aria-invalid={fieldErrors.targetHost ? "true" : undefined} /></label>
              {fieldAlert("targetHost", "forwarding.field.invalid_host")}
              <label>{t("forwarding.target_port")} <input className="ui-control" inputMode="numeric" value={targetPort} onChange={(event) => { setTargetPort(event.target.value); setFieldErrors((current) => ({ ...current, targetPort: false })); }} aria-invalid={fieldErrors.targetPort ? "true" : undefined} /></label>
              {fieldAlert("targetPort", "forwarding.field.invalid_port")}
            </>
          )}
          {kind === "remote" && (
            <>
              <label>{t("forwarding.local_target_port")} <input className="ui-control" inputMode="numeric" value={targetPort} onChange={(event) => { setTargetPort(event.target.value); setFieldErrors((current) => ({ ...current, targetPort: false })); }} aria-invalid={fieldErrors.targetPort ? "true" : undefined} /></label>
              {fieldAlert("targetPort", "forwarding.field.invalid_port")}
            </>
          )}
          <label><input className="ui-choice" type="checkbox" checked={recreateOnReconnect} onChange={(event) => setRecreateOnReconnect(event.target.checked)} /> {t("forwarding.recreate")}</label>
          <button type="submit" className="ui-button ui-button--primary" disabled={loading}>{t("forwarding.start")}</button>
        </form>
      )}
      {errorCode && <div role="alert">{t(`forwarding.error.${errorCode}`)}</div>}
      {loading && <div role="status">{t("forwarding.loading")}</div>}
      <h3 style={{ margin: 0, fontSize: "var(--fs-body)" }}>{t("forwarding.active")}</h3>
      {localRules.length + dynamicRules.length + remoteRules.length === 0 && !loading && <p>{t("forwarding.empty")}</p>}
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 8 }}>
        {localRules.map((rule) => {
          const endpoint = `${rule.bindHost}:${rule.localPort}`;
          return (
          <li key={rule.ruleId} style={{ padding: 9, border: "1px solid var(--c-border-1)", borderRadius: "var(--r-card)", background: "var(--c-bg-1)", display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <strong>{t("forwarding.local")}</strong>{" "}
            <code>{endpoint} → {rule.targetHost}:{rule.targetPort}</code>{" "}
            <span>{rule.requestedLocalPort === 0 ? t("forwarding.ephemeral") : t("forwarding.requested", { port: rule.requestedLocalPort })}</span>{" "}
            {rule.recreateOnReconnect && <span>{t("forwarding.recreate_badge")}</span>}{" "}
            {rule.requestedLocalPort === 0 && (
              <PanelActionButton onClick={() => { void copyEndpoint(endpoint); }} aria-label={t("forwarding.copy_endpoint", { endpoint })}>
                {t("forwarding.copy")}
              </PanelActionButton>
            )}
            <button type="button" className="ui-button ui-button--danger" onClick={() => { void stop(rule, "local"); }} disabled={loading}>{t("forwarding.stop")}</button>
          </li>
          );
        })}
        {dynamicRules.map((rule) => {
          const endpoint = `${rule.bindHost}:${rule.localPort}`;
          return (
          <li key={rule.ruleId} style={{ padding: 9, border: "1px solid var(--c-border-1)", borderRadius: "var(--r-card)", background: "var(--c-bg-1)", display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <strong>{t("forwarding.dynamic")}</strong>{" "}
            <code>SOCKS5 {endpoint}</code>{" "}
            <span>{rule.requestedLocalPort === 0 ? t("forwarding.ephemeral") : t("forwarding.requested", { port: rule.requestedLocalPort })}</span>{" "}
            {rule.recreateOnReconnect && <span>{t("forwarding.recreate_badge")}</span>}{" "}
            {rule.requestedLocalPort === 0 && (
              <PanelActionButton onClick={() => { void copyEndpoint(endpoint); }} aria-label={t("forwarding.copy_endpoint", { endpoint })}>
                {t("forwarding.copy")}
              </PanelActionButton>
            )}
            <button type="button" className="ui-button ui-button--danger" onClick={() => { void stop(rule, "dynamic"); }} disabled={loading}>{t("forwarding.stop")}</button>
          </li>
          );
        })}
        {remoteRules.map((rule) => (
          <li key={rule.ruleId} style={{ padding: 9, border: "1px solid var(--c-border-1)", borderRadius: "var(--r-card)", background: "var(--c-bg-1)", display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
            <strong>{t("forwarding.remote")}</strong>{" "}
            <code>{rule.remoteBindHost}:{rule.remotePort} → {rule.localTargetHost}:{rule.localTargetPort}</code>{" "}
            <span>{rule.requestedRemotePort === 0 ? t("forwarding.ephemeral") : t("forwarding.requested", { port: rule.requestedRemotePort })}</span>{" "}
            {rule.recreateOnReconnect && <span>{t("forwarding.recreate_badge")}</span>}{" "}
            <button type="button" className="ui-button ui-button--danger" onClick={() => { void stop(rule, "remote"); }} disabled={loading}>{t("forwarding.stop")}</button>
          </li>
        ))}
      </ul>
      </div>
    </section>
  );
}

