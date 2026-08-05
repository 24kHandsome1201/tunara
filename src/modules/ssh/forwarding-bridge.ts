import { invoke } from "@tauri-apps/api/core";
import type { SessionBindingV1 } from "@/modules/terminal/lib/pty-bridge";

export type ForwardingErrorCode =
  | "fixedPortUnavailable"
  | "staleBinding"
  | "limitExceeded"
  | "invalidIntent"
  | "internal";

export class ForwardingCommandError extends Error {
  constructor(public readonly code: ForwardingErrorCode) {
    super(`SSH forwarding failed: ${code}`);
    this.name = "ForwardingCommandError";
  }
}

export interface LocalForwardView {
  ruleId: string;
  binding: SessionBindingV1;
  bindHost: string;
  localPort: number;
  requestedLocalPort: number;
  recreateOnReconnect: boolean;
  targetHost: string;
  targetPort: number;
}

export interface DynamicForwardView {
  ruleId: string;
  binding: SessionBindingV1;
  bindHost: string;
  localPort: number;
  requestedLocalPort: number;
  recreateOnReconnect: boolean;
}

function forwardingErrorCode(error: unknown): ForwardingErrorCode {
  const message = String(error);
  if (message.includes("SSH_FORWARDING_STALE_BINDING")) return "staleBinding";
  if (message.includes("SSH_FORWARDING_LIMIT_EXCEEDED")) return "limitExceeded";
  if (message.includes("SSH_FORWARDING_FIXED_PORT_UNAVAILABLE")) return "fixedPortUnavailable";
  if (message.includes("SSH_FORWARDING_INVALID_INTENT")) return "invalidIntent";
  return "internal";
}

async function invokeForwarding<T>(command: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw new ForwardingCommandError(forwardingErrorCode(error));
  }
}

export function listLocalForwards(binding: SessionBindingV1): Promise<LocalForwardView[]> {
  return invokeForwarding("ssh_local_forward_list", { binding });
}

export function startLocalForward(
  binding: SessionBindingV1,
  request: {
    localPort: number;
    targetHost: string;
    targetPort: number;
    recreateOnReconnect: boolean;
  },
): Promise<LocalForwardView> {
  return invokeForwarding("ssh_local_forward_start", {
    binding,
    bindHost: "127.0.0.1",
    ...request,
  });
}

export function stopLocalForward(binding: SessionBindingV1, ruleId: string): Promise<void> {
  return invokeForwarding("ssh_local_forward_stop", { binding, ruleId });
}

export function listDynamicForwards(binding: SessionBindingV1): Promise<DynamicForwardView[]> {
  return invokeForwarding("ssh_dynamic_forward_list", { binding });
}

export function startDynamicForward(
  binding: SessionBindingV1,
  request: { localPort: number; recreateOnReconnect: boolean },
): Promise<DynamicForwardView> {
  return invokeForwarding("ssh_dynamic_forward_start", {
    binding,
    bindHost: "127.0.0.1",
    ...request,
  });
}

export function stopDynamicForward(binding: SessionBindingV1, ruleId: string): Promise<void> {
  return invokeForwarding("ssh_dynamic_forward_stop", { binding, ruleId });
}
