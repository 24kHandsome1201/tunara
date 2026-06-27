import { useCallback, useSyncExternalStore } from "react";
import zhCN from "./locales/zh-CN.json" with { type: "json" };
import en from "./locales/en.json" with { type: "json" };

export type Language = "system" | "zh-CN" | "en";

export const LANGUAGES: Language[] = ["system", "zh-CN", "en"];

type Dict = Record<string, string>;

const DICTS: Record<Exclude<Language, "system">, Dict> = {
  "zh-CN": zhCN as Dict,
  en: en as Dict,
};

const FALLBACK: Exclude<Language, "system"> = "zh-CN";

function detectSystemLanguage(): Exclude<Language, "system"> {
  if (typeof navigator === "undefined") return FALLBACK;
  const tags: string[] = [];
  if (Array.isArray(navigator.languages)) tags.push(...navigator.languages);
  if (navigator.language) tags.push(navigator.language);
  for (const tag of tags) {
    const lower = tag.toLowerCase();
    if (lower.startsWith("zh")) return "zh-CN";
    if (lower.startsWith("en")) return "en";
  }
  return "en";
}

let currentLanguage: Language = "system";
let resolvedLanguage: Exclude<Language, "system"> = detectSystemLanguage();
const listeners = new Set<() => void>();

function resolve(language: Language): Exclude<Language, "system"> {
  return language === "system" ? detectSystemLanguage() : language;
}

export function setLanguage(language: Language): void {
  currentLanguage = LANGUAGES.includes(language) ? language : "system";
  resolvedLanguage = resolve(currentLanguage);
  for (const listener of listeners) listener();
}

export function getLanguage(): Language {
  return currentLanguage;
}

export function getResolvedLanguage(): Exclude<Language, "system"> {
  return resolvedLanguage;
}

export function t(key: string, params?: Record<string, string | number>): string {
  const dict = DICTS[resolvedLanguage] ?? DICTS[FALLBACK];
  let value = dict[key] ?? DICTS[FALLBACK][key] ?? key;
  if (params) {
    for (const [name, replacement] of Object.entries(params)) {
      value = value.replace(new RegExp(`{{\\s*${name}\\s*}}`, "g"), String(replacement));
    }
  }
  return value;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): Exclude<Language, "system"> {
  return resolvedLanguage;
}

export function useT(): (key: string, params?: Record<string, string | number>) => string {
  const lang = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return useCallback((key, params) => {
    void lang;
    return t(key, params);
  }, [lang]);
}

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (LANGUAGES as string[]).includes(value);
}
