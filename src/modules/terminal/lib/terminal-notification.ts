export interface TerminalNotification {
  title: string;
  body?: string;
}

const MAX_TITLE_LENGTH = 120;
const MAX_BODY_LENGTH = 200;

export function parseTerminalNotificationOsc9(data: string): TerminalNotification | null {
  if (/^\s*\d+(?:;|$)/.test(data)) return null;
  const title = normalizeNotificationPart(data, MAX_TITLE_LENGTH);
  return title ? { title } : null;
}

export function parseTerminalNotificationOsc777(data: string): TerminalNotification | null {
  const parts = data.split(";");
  if (parts[0] !== "notify") return null;

  const title = normalizeNotificationPart(parts[1] ?? "", MAX_TITLE_LENGTH);
  const body = normalizeNotificationPart(parts.slice(2).join(";"), MAX_BODY_LENGTH);
  if (!title && !body) return null;

  return {
    title: title || "终端通知",
    ...(body ? { body } : {}),
  };
}

function normalizeNotificationPart(value: string, maxLength: number): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.slice(0, maxLength - 3) + "...";
}
