import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useSessionsStore } from "@/state/sessions";
import { parseAgentHookEvent } from "./agent-lifecycle";

export async function startHooksListener(): Promise<UnlistenFn> {
  return listen<unknown>("agent-hook", (e) => {
    const payload = parseAgentHookEvent(e.payload);
    if (!payload) return;
    const { event, session, agent, code, agentSessionId } = payload;
    const store = useSessionsStore.getState();

    if (event === "start") {
      store.handleAgentDetected(session, agent);
      return;
    }
    if (event === "exit") {
      const current = useSessionsStore.getState().sessions.find((s) => s.id === session);
      if (current?.agent === agent) {
        store.handleAgentExited(session, code ?? 0);
      }
      return;
    }
    if (event === "busy" || event === "stop" || event === "idle") {
      const current = useSessionsStore.getState().sessions.find((s) => s.id === session);
      if (current?.agent === agent) {
        // The real agent session id rides in on the SessionStart/Stop/idle hook
        // payload — record it so resume targets the exact conversation instead of
        // scraping the typed command.
        if (agentSessionId) store.recordAgentSessionId(session, agent, agentSessionId);
        if (event === "busy") store.handleAgentBusy(session);
        else store.handleAgentReady(session);
      }
    }
  });
}
