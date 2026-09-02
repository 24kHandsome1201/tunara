import { useEffect } from "react";
import { useSessionsStore } from "@/state/sessions";
import { setDockBadge } from "@/ui/dock-badge";
import { resetBackgroundAttention } from "@/ui/lib/background-attention-state";
import { dockBadgeCount } from "@/modules/session/session-attention";
import { requestInformationalAttention } from "@/ui/terminal-attention";

export function useDockBadge() {
  useEffect(() => {
    const sync = () => {
      // Only badge when the window doesn't have focus. N is the same waiting
      // count as the sidebar attention row (session-attention.dockBadgeCount).
      if (document.hasFocus()) {
        setDockBadge(0);
        resetBackgroundAttention();
        return;
      }
      const sessions = useSessionsStore.getState().sessions;
      const count = dockBadgeCount(sessions);
      setDockBadge(count);
      if (count > 0) requestInformationalAttention("needs-you");
    };

    sync();
    const unsubscribe = useSessionsStore.subscribe(sync);
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    return () => {
      unsubscribe();
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
    };
  }, []);
}
