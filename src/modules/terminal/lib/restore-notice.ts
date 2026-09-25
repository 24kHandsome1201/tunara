import { t } from "@/modules/i18n/core.ts";
import { useUIStore } from "@/state/ui";

let announced = false;

/** One toast per app launch when terminal snapshots are replayed, instead of a line in every terminal. */
export function announceSnapshotRestored(): void {
  if (announced) return;
  announced = true;
  useUIStore.getState().addToast({ title: t("terminal.restored_toast"), subtitle: "", variant: "success" });
}
