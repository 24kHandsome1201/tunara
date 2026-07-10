export const SESSION_MASCOT_IDS = [
  "cat",
  "dog",
  "fox",
  "panda",
  "hamster",
  "frog",
  "koala",
  "penguin",
  "rabbit",
  "lion",
  "bear",
  "owl",
  "hedgehog",
  "raccoon",
  "sloth",
  "otter",
] as const;

export type SessionMascotId = (typeof SESSION_MASCOT_IDS)[number];

export function isSessionMascotId(value: unknown): value is SessionMascotId {
  return typeof value === "string" && (SESSION_MASCOT_IDS as readonly string[]).includes(value);
}
