import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useSessionsStore } from "@/state/sessions";
import type { AgentCode } from "@/ui/types";

interface AgentHookEvent {
  event: string;
  session: string;
  agent?: AgentCode | null;
  code?: number | null;
}

export async function startHooksListener(): Promise<UnlistenFn> {
  return listen<AgentHookEvent>("agent-hook", (e) => {
    const { event, session, agent, code } = e.payload;
    const store = useSessionsStore.getState();

    if (event === "start" && agent) {
      store.handleAgentDetected(session, agent);
      return;
    }
    if (event === "exit") {
      const current = useSessionsStore.getState().sessions.find((s) => s.id === session);
      if (current?.agent && (!agent || current.agent === agent)) {
        store.handleAgentExited(session, code ?? 0);
      }
      return;
    }
    if ((event === "stop" || event === "idle") && agent) {
      const current = useSessionsStore.getState().sessions.find((s) => s.id === session);
      if (current?.agent === agent) {
        store.handleAgentReady(session);
      }
    }
  });
}
