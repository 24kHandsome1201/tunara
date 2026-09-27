import type { Toast } from "@/state/ui";

export type ErrorToastInput = {
  /** What failed, e.g. t("explorer.download.failed"). */
  title: string;
  /** What the user can do next — shown as the toast subtitle. */
  next: string;
  /** Raw error; stored on `errorDetail` so the copy action carries it. */
  error?: unknown;
  sessionId?: string;
  action?: Toast["action"];
  durationMs?: number;
};

/** Canonical error toast: title = what failed, subtitle = next step; the raw
 * error never goes into the subtitle and only reaches the user via copy. */
export function errorToast({ title, next, error, sessionId, action, durationMs }: ErrorToastInput): Omit<Toast, "id"> {
  return {
    title,
    subtitle: next,
    errorDetail: error instanceof Error ? error.message : typeof error === "string" && error ? error : undefined,
    sessionId,
    action,
    durationMs,
    variant: "error",
  };
}
