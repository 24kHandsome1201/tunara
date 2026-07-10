import { useEffect } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { t } from "@/modules/i18n";
import { useUIStore } from "@/state/ui";

export const UPDATE_REMINDER_DELAY_MS = 18_000;

/**
 * Check the signed release channel after the workspace is usable. The check is
 * intentionally delayed and silent on failure: opening a terminal must never
 * wait on the network, and an unavailable update server is not user work.
 */
export function useUpdateReminder(ready: boolean): void {
  useEffect(() => {
    if (!ready || import.meta.env.DEV) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void check({ timeout: 15_000 })
        .then(async (update) => {
          if (!update) return;
          const version = update.version;
          await update.close().catch(() => {});
          if (cancelled) return;
          useUIStore.getState().addToast({
            title: t("update.reminder.title", { version }),
            subtitle: t("update.reminder.subtitle"),
            variant: "warning",
            durationMs: 10_000,
            action: {
              kind: "open-settings",
              tab: "app",
              label: t("update.reminder.action"),
            },
          });
        })
        .catch(() => {
          // A background check must stay quieter than the terminal it serves.
        });
    }, UPDATE_REMINDER_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [ready]);
}
