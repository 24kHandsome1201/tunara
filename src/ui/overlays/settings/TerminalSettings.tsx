import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useUIStore, type CursorStyle, type ExternalEditor, EXTERNAL_EDITORS, EDITOR_LABELS } from "@/state/ui";
import { useT } from "@/modules/i18n";
import {
  clearTerminalWallpaper,
  importTerminalWallpaper,
} from "@/modules/terminal/lib/terminal-wallpaper-bridge";
import {
  MAX_WALLPAPER_BLUR,
  MAX_WALLPAPER_VEIL,
  MIN_WALLPAPER_BLUR,
  MIN_WALLPAPER_VEIL,
  TERMINAL_WALLPAPER_SOURCES,
} from "@/modules/terminal/lib/terminal-wallpaper";
import { wallpaperTextureUrl } from "@/modules/terminal/lib/terminal-wallpaper-textures";
import { usePrefersReducedTransparency } from "@/ui/usePrefersReducedTransparency";
import {
  RangeRow,
  SECTION_HINT,
  SECTION_LABEL,
  SECTION_LABEL_INLINE,
  Segmented,
  Stepper,
  Toggle,
  ToggleRow,
  TOGGLE_ROW,
} from "./controls";

export function WallpaperSettings() {
  const t = useT();
  const enabled = useUIStore((s) => s.terminalWallpaperEnabled);
  const source = useUIStore((s) => s.terminalWallpaperSource);
  const blur = useUIStore((s) => s.terminalWallpaperBlur);
  const veil = useUIStore((s) => s.terminalWallpaperVeil);
  const setEnabled = useUIStore((s) => s.setTerminalWallpaperEnabled);
  const setSource = useUIStore((s) => s.setTerminalWallpaperSource);
  const setBlur = useUIStore((s) => s.setTerminalWallpaperBlur);
  const setVeil = useUIStore((s) => s.setTerminalWallpaperVeil);
  const addToast = useUIStore((s) => s.addToast);
  const reducedTransparency = usePrefersReducedTransparency();
  const [busy, setBusy] = useState(false);

  async function chooseCustom() {
    if (busy) return;
    setBusy(true);
    try {
      const selected = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
      });
      if (typeof selected !== "string" || !selected) return;
      await importTerminalWallpaper(selected);
      setSource("custom");
      setEnabled(true);
      useUIStore.getState().bumpTerminalWallpaperRevision();
    } catch {
      addToast({
        title: t("settings.appearance.wallpaper.invalid"),
        subtitle: "",
        variant: "error",
      });
    } finally {
      setBusy(false);
    }
  }

  async function removeCustom() {
    if (busy) return;
    setBusy(true);
    try {
      await clearTerminalWallpaper();
      if (source === "custom") setSource("paper");
      useUIStore.getState().bumpTerminalWallpaperRevision();
    } catch {
      addToast({
        title: t("settings.appearance.wallpaper.invalid"),
        subtitle: "",
        variant: "error",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-settings-section="wallpaper" style={{ marginBottom: 8 }}>
      <ToggleRow
        label={t("settings.appearance.wallpaper")}
        hint={t("settings.appearance.wallpaper.hint")}
        checked={enabled}
        onChange={setEnabled}
      />
      {reducedTransparency && enabled && (
        <div style={{ ...SECTION_HINT, marginTop: -12, marginBottom: 16 }}>{t("settings.appearance.wallpaper.reduced")}</div>
      )}
      {enabled && (
        <div>
          <div style={SECTION_LABEL}>{t("settings.appearance.wallpaper.source")}</div>
          <div role="radiogroup" aria-label={t("settings.appearance.wallpaper.source")} style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 8, marginBottom: 16 }}>
            {TERMINAL_WALLPAPER_SOURCES.map((id) => {
              const selected = source === id;
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => { if (id === "custom") void chooseCustom(); else setSource(id); }}
                  style={{
                    height: 56,
                    borderRadius: "var(--r-btn)",
                    border: selected ? "2px solid var(--c-accent)" : "1px solid var(--c-border-2)",
                    background: id === "custom" ? "var(--c-bg-white)" : `center / 80px url("${wallpaperTextureUrl(id)}")`,
                    color: "var(--c-text-2)",
                    fontSize: "var(--fs-meta)",
                    fontWeight: 600,
                    cursor: "pointer",
                    overflow: "hidden",
                  }}
                >
                  {t(`settings.appearance.wallpaper.${id}`)}
                </button>
              );
            })}
          </div>
          {source === "custom" && (
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              <button
                type="button"
                onClick={() => void chooseCustom()}
                disabled={busy}
                style={{ height: 30, padding: "0 10px", borderRadius: "var(--r-btn)", border: "1px solid var(--c-border-2)", background: "var(--c-bg-white)", color: "var(--c-text-2)", fontSize: "var(--fs-secondary)", fontWeight: 600, cursor: "pointer" }}
              >
                {t("settings.appearance.wallpaper.choose")}
              </button>
              <button
                type="button"
                onClick={() => void removeCustom()}
                disabled={busy}
                style={{ height: 30, padding: "0 10px", borderRadius: "var(--r-btn)", border: "1px solid var(--c-border-2)", background: "var(--c-bg-white)", color: "var(--c-text-3)", fontSize: "var(--fs-secondary)", cursor: "pointer" }}
              >
                {t("settings.appearance.wallpaper.remove")}
              </button>
            </div>
          )}
          <RangeRow
            label={t("settings.appearance.wallpaper.blur")}
            ariaLabel={t("settings.appearance.wallpaper.blur")}
            value={blur}
            min={MIN_WALLPAPER_BLUR}
            max={MAX_WALLPAPER_BLUR}
            display={`${blur}px`}
            onChange={setBlur}
          />
          <RangeRow
            label={t("settings.appearance.wallpaper.veil")}
            ariaLabel={t("settings.appearance.wallpaper.veil")}
            value={veil}
            min={MIN_WALLPAPER_VEIL}
            max={MAX_WALLPAPER_VEIL}
            display={`${veil}%`}
            onChange={setVeil}
          />
          <div style={{ ...SECTION_HINT, marginBottom: 24 }}>{t("settings.appearance.wallpaper.sixel")}</div>
        </div>
      )}
    </div>
  );
}

function CursorStylePicker({ value, onChange }: { value: CursorStyle; onChange: (v: CursorStyle) => void }) {
  const t = useT();
  return (
    <Segmented
      ariaLabel={t("settings.appearance.cursor_style")}
      options={[
        { id: "bar", label: t("settings.appearance.cursor.bar") },
        { id: "block", label: t("settings.appearance.cursor.block") },
        { id: "underline", label: t("settings.appearance.cursor.underline") },
      ]}
      value={value}
      onChange={onChange}
    />
  );
}

/** Terminal tab: cursor, fonts, scrollback, clipboard, and editor. */
export function TerminalSettings() {
  const t = useT();
  const cursorStyle = useUIStore((s) => s.cursorStyle);
  const setCursorStyle = useUIStore((s) => s.setCursorStyle);
  const cursorBlink = useUIStore((s) => s.cursorBlink);
  const setCursorBlink = useUIStore((s) => s.setCursorBlink);
  const fontSize = useUIStore((s) => s.fontSize);
  const setFontSize = useUIStore((s) => s.setFontSize);
  const fontFamily = useUIStore((s) => s.fontFamily);
  const setFontFamily = useUIStore((s) => s.setFontFamily);
  const fontLigatures = useUIStore((s) => s.fontLigatures);
  const setFontLigatures = useUIStore((s) => s.setFontLigatures);
  const nerdFontFallback = useUIStore((s) => s.nerdFontFallback);
  const setNerdFontFallback = useUIStore((s) => s.setNerdFontFallback);
  const scrollback = useUIStore((s) => s.scrollback);
  const setScrollback = useUIStore((s) => s.setScrollback);
  const bellNotification = useUIStore((s) => s.bellNotification);
  const setBellNotification = useUIStore((s) => s.setBellNotification);
  const terminalClipboardWrite = useUIStore((s) => s.terminalClipboardWrite);
  const setTerminalClipboardWrite = useUIStore((s) => s.setTerminalClipboardWrite);
  const terminalInlineImages = useUIStore((s) => s.terminalInlineImages);
  const setTerminalInlineImages = useUIStore((s) => s.setTerminalInlineImages);
  const showPureModeFilesButton = useUIStore((s) => s.showPureModeFilesButton);
  const setShowPureModeFilesButton = useUIStore((s) => s.setShowPureModeFilesButton);
  const externalEditor = useUIStore((s) => s.externalEditor);
  const setExternalEditor = useUIStore((s) => s.setExternalEditor);

  const [fontDraft, setFontDraft] = useState(fontFamily);
  useEffect(() => { setFontDraft(fontFamily); }, [fontFamily]);

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <div style={TOGGLE_ROW}>
          <span style={SECTION_LABEL_INLINE}>{t("settings.appearance.cursor_style")}</span>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
            <span style={{ fontSize: "var(--fs-secondary)", color: "var(--c-text-4)" }}>{t("settings.appearance.cursor_blink")}</span>
            <Toggle checked={cursorBlink} onChange={setCursorBlink} ariaLabel={t("settings.appearance.cursor_blink")} />
          </label>
        </div>
        <CursorStylePicker value={cursorStyle} onChange={setCursorStyle} />
      </div>
      <div style={{ marginBottom: 24 }}>
        <div style={SECTION_LABEL}>{t("settings.appearance.font_size")}</div>
        <Stepper
          display={`${fontSize}px`}
          valueMinWidth={48}
          decrementLabel={t("common.decrement")}
          incrementLabel={t("common.increment")}
          onDecrement={() => setFontSize(Math.max(10, fontSize - 1))}
          onIncrement={() => setFontSize(Math.min(22, fontSize + 1))}
        />
      </div>
      <div style={{ marginBottom: 24 }}>
        <div style={SECTION_LABEL}>{t("settings.appearance.font_family")}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <input
            value={fontDraft}
            onChange={(e) => setFontDraft(e.target.value)}
            onBlur={() => setFontFamily(fontDraft)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                setFontFamily(fontDraft);
                e.currentTarget.blur();
              }
            }}
            spellCheck={false}
            style={{ flex: "1 1 260px", minWidth: 0, height: 30, border: "1px solid var(--c-border-2)", borderRadius: "var(--r-btn)", background: "var(--c-bg-white)", color: "var(--c-text-primary)", padding: "0 10px", fontFamily: "var(--font-mono)", fontSize: "var(--fs-body)", outline: "none" }}
          />
          <button
            type="button"
            aria-pressed={nerdFontFallback}
            onClick={() => setNerdFontFallback(!nerdFontFallback)}
            style={{
              height: 30, padding: "0 10px", borderRadius: "var(--r-btn)", border: "1px solid var(--c-border-2)", cursor: "pointer",
              background: nerdFontFallback ? "var(--c-accent)" : "var(--c-bg-white)",
              color: nerdFontFallback ? "var(--c-btn-primary-text)" : "var(--c-text-3)",
              fontSize: "var(--fs-secondary)", fontWeight: 600, flexShrink: 0,
            }}
          >
            {t("settings.appearance.nerd_font")}
          </button>
          <button
            type="button"
            aria-pressed={fontLigatures}
            onClick={() => setFontLigatures(!fontLigatures)}
            style={{
              height: 30, padding: "0 10px", borderRadius: "var(--r-btn)", border: "1px solid var(--c-border-2)", cursor: "pointer",
              background: fontLigatures ? "var(--c-accent)" : "var(--c-bg-white)",
              color: fontLigatures ? "var(--c-btn-primary-text)" : "var(--c-text-3)",
              fontSize: "var(--fs-secondary)", fontWeight: 600, flexShrink: 0,
            }}
          >
            {t("settings.appearance.ligatures")}
          </button>
        </div>
        <div style={{ ...SECTION_HINT, marginTop: 6 }}>
          {t("settings.appearance.font_family.suggest")}
        </div>
      </div>
      <div style={{ marginBottom: 24 }}>
        <div style={SECTION_LABEL}>{t("settings.appearance.scrollback")}</div>
        <Stepper
          display={`${scrollback}`}
          valueMinWidth={64}
          decrementLabel={t("common.decrement")}
          incrementLabel={t("common.increment")}
          onDecrement={() => setScrollback(Math.max(1000, scrollback - 1000))}
          onIncrement={() => setScrollback(Math.min(20000, scrollback + 1000))}
        />
      </div>
      <ToggleRow label={t("settings.appearance.bell_notification")} hint={t("settings.appearance.bell_notification.hint")} checked={bellNotification} onChange={setBellNotification} />
      <ToggleRow label={t("settings.appearance.clipboard_write")} hint={t("settings.appearance.clipboard_write.hint")} checked={terminalClipboardWrite} onChange={() => setTerminalClipboardWrite(!terminalClipboardWrite)} />
      <ToggleRow label={t("settings.appearance.inline_images")} hint={t("settings.appearance.inline_images.hint")} checked={terminalInlineImages} onChange={setTerminalInlineImages} />
      <WallpaperSettings />
      <ToggleRow label={t("settings.appearance.pure_files_button")} hint={t("settings.appearance.pure_files_button.hint")} checked={showPureModeFilesButton} onChange={setShowPureModeFilesButton} />
      <div style={{ marginTop: 24 }}>
        <div style={SECTION_LABEL}>{t("settings.appearance.external_editor")}</div>
        <Segmented
          ariaLabel={t("settings.appearance.external_editor")}
          options={EXTERNAL_EDITORS.map((ed: ExternalEditor) => ({ id: ed, label: EDITOR_LABELS[ed] }))}
          value={externalEditor}
          onChange={setExternalEditor}
        />
      </div>
    </div>
  );
}
