export const SESSION_MASCOT_IDS = [
  "cat",
  "dog",
  "fox",
  "panda",
  "hamster",
  "frog",
  "koala",
  "penguin",
] as const;

export type SessionMascotId = (typeof SESSION_MASCOT_IDS)[number];

export function isSessionMascotId(value: unknown): value is SessionMascotId {
  return typeof value === "string" && (SESSION_MASCOT_IDS as readonly string[]).includes(value);
}
