import { useEffect, useRef } from "react";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";
import { useUIStore } from "@/state/ui";
import { t } from "@/modules/i18n/core.ts";
import { tryGetCurrentWindow } from "@/ui/lib/current-window";

// Toggle the main window on the global summon hotkey: hide when visible, show
// + focus when hidden. Acts like a hotkey-window/quake terminal without adding
// a second window — the existing three-pane shell slides in/out.
async function toggleMainWindow(): Promise<void> {
  try {
    const win = tryGetCurrentWindow();
    if (!win) return;
    const visible = await win.isVisible();
    if (visible) {
      await win.hide();
    } else {
      await win.show();
      await win.setFocus();
    }
  } catch (e) {
    console.warn("[useGlobalShortcut] toggle window failed", e);
  }
}

export function useGlobalShortcut() {
  const globalShortcut = useUIStore((s) => s.globalShortcut);
  const configLoaded = useUIStore((s) => s.configLoaded);
  // Track the currently-registered accelerator so a config change can
  // unregister the old one before registering the new one.
  const registeredRef = useRef<string | null>(null);
  const requestRef = useRef(0);
  const operationQueueRef = useRef(Promise.resolve());

  useEffect(() => {
    if (!configLoaded) return;
    const next = globalShortcut.trim();
    const request = ++requestRef.current;

    async function apply() {
      if (request !== requestRef.current) return;
      const prev = registeredRef.current;
      // Unregister the previous binding if any.
      if (prev) {
        try { await unregister(prev); } catch { /* already gone */ }
      }
      registeredRef.current = null;
      if (request !== requestRef.current) return;

      // Empty string = disabled.
      if (!next) return;

      try {
        await register(next, (event) => {
          if (event.state === "Pressed") void toggleMainWindow();
        });
        if (request !== requestRef.current) {
          try { await unregister(next); } catch { /* replaced while registering */ }
          return;
        }
        registeredRef.current = next;
      } catch {
        if (request !== requestRef.current) return;
        // Registration fails when the key is taken by another app or the
        // accelerator string is invalid. Surface it so the user can rebind
        // instead of silently owning a dead hotkey.
        useUIStore.getState().addToast({
          title: t("settings.global_shortcut.conflict"),
          subtitle: next,
          variant: "error",
        });
      }
    }

    const operation = operationQueueRef.current.then(apply);
    operationQueueRef.current = operation.catch(() => {});
  }, [globalShortcut, configLoaded]);

  useEffect(() => () => {
    ++requestRef.current;
    operationQueueRef.current = operationQueueRef.current.then(async () => {
      const held = registeredRef.current;
      if (!held) return;
      try { await unregister(held); } catch { /* ignore teardown failures */ }
      registeredRef.current = null;
    });
  }, []);
}
