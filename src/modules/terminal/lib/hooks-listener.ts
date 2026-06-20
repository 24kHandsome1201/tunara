import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useSessionsStore } from "@/state/sessions";

interface AgentHookEvent {
  event: string;
  session: string;
}

export async function startHooksListener(): Promise<UnlistenFn> {
  return listen<AgentHookEvent>("agent-hook", (e) => {
    const { event, session } = e.payload;
    const store = useSessionsStore.getState();
    const sess = store.sessions.find((s) => s.id === session);

    if (!sess?.agent) return;
    if (event === "stop" || event === "idle") {
      store.handleAgentTurnDone(session);
    }
  });
}
