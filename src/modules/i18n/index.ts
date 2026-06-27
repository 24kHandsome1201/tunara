import { useCallback, useSyncExternalStore } from "react";
import { getI18nSnapshot, subscribeI18n, t } from "./core.ts";

export {
  getLanguage,
  getResolvedLanguage,
  isLanguage,
  LANGUAGES,
  setLanguage,
  t,
  type Language,
} from "./core.ts";

export function useT(): (key: string, params?: Record<string, string | number>) => string {
  const lang = useSyncExternalStore(subscribeI18n, getI18nSnapshot, getI18nSnapshot);
  return useCallback((key, params) => {
    void lang;
    return t(key, params);
  }, [lang]);
}
