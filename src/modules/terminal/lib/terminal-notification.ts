import { t } from "../../i18n/core.ts";

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
    title: title || t("terminal.notification.default"),
    ...(body ? { body } : {}),
  };
}

interface Osc99Pending {
  title: string;
  body: string;
}

const MAX_OSC99_PENDING = 32;

function decodeOsc99Payload(payload: string, encoding: string | undefined): string {
  if (encoding !== "1") return payload;
  try {
    const binary = atob(payload);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return "";
  }
}

function parseOsc99Metadata(raw: string): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const pair of raw.split(":")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    meta[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return meta;
}

export function createOsc99Assembler(): {
  ingest(data: string): TerminalNotification | null;
  reset(): void;
} {
  const pending = new Map<string, Osc99Pending>();
  return {
    ingest(data: string): TerminalNotification | null {
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(data)) return null;
      const separator = data.indexOf(";");
      const meta = parseOsc99Metadata(separator === -1 ? data : data.slice(0, separator));
      const payload = decodeOsc99Payload(separator === -1 ? "" : data.slice(separator + 1), meta.e);
      const id = meta.i ?? "";
      const current = pending.get(id) ?? { title: "", body: "" };
      const kind = meta.p;
      if (kind === "title") current.title = normalizeNotificationPart(payload, MAX_TITLE_LENGTH);
      else if (kind === "body") current.body = normalizeNotificationPart(payload, MAX_BODY_LENGTH);
      else if (payload) {
        if (!current.title) current.title = normalizeNotificationPart(payload, MAX_TITLE_LENGTH);
        else current.body = normalizeNotificationPart(payload, MAX_BODY_LENGTH);
      }
      const done = meta.d === "1" || (meta.d === undefined && !id && (!!current.title || !!current.body));
      if (!done) {
        if (pending.size >= MAX_OSC99_PENDING && !pending.has(id)) pending.clear();
        pending.set(id, current);
        return null;
      }
      pending.delete(id);
      if (!current.title && !current.body) return null;
      return {
        title: current.title || t("terminal.notification.default"),
        ...(current.body ? { body: current.body } : {}),
      };
    },
    reset() {
      pending.clear();
    },
  };
}

function normalizeNotificationPart(value: string, maxLength: number): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.slice(0, maxLength - 3) + "...";
}
