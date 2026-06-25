import { useEffect } from "react";
import { useSessionsStore } from "@/state/sessions";
import { setDockBadge } from "@/ui/dock-badge";

export function useDockBadge() {
  useEffect(() => {
    const sync = () => {
      // Only badge when the window doesn't have focus — once the user looks at the app,
      // the unread state will clear naturally via markRead and the badge follows.
      if (document.hasFocus()) {
        setDockBadge(0);
        return;
      }
      const sessions = useSessionsStore.getState().sessions;
      const count = sessions.reduce((n, s) => (s.unread ? n + 1 : n), 0);
      setDockBadge(count);
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
