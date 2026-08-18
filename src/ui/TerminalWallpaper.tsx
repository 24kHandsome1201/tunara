import { useEffect, useState } from "react";
import { useUIStore } from "@/state/ui";
import { getTerminalTheme, isTerminalThemeDark } from "@/styles/terminalTheme";
import { loadTerminalWallpaper } from "@/modules/terminal/lib/terminal-wallpaper-bridge";
import { wallpaperTextureUrl } from "@/modules/terminal/lib/terminal-wallpaper-textures";
import {
  resolveWallpaperLayer,
  type WallpaperLayer,
} from "@/modules/terminal/lib/terminal-wallpaper";
import { usePrefersReducedTransparency } from "./usePrefersReducedTransparency";

const DOWNSCALE_MAX = 1280;

function bytesToObjectUrl(bytes: number[], mime: string): string {
  return URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
}

function sampleAverage(image: HTMLImageElement): string {
  const canvas = document.createElement("canvas");
  canvas.width = 8;
  canvas.height = 8;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return "#808080";
  ctx.drawImage(image, 0, 0, 8, 8);
  const data = ctx.getImageData(0, 0, 8, 8).data;
  let r = 0, g = 0, b = 0, count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 8) continue;
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    count += 1;
  }
  if (count === 0) return "#808080";
  const hex = (n: number) => Math.round(n / count).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

function downscale(image: HTMLImageElement): Promise<{ url: string; average: string }> {
  const scale = Math.min(1, DOWNSCALE_MAX / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return Promise.resolve({ url: image.src, average: sampleAverage(image) });
  ctx.drawImage(image, 0, 0, width, height);
  const average = sampleAverage(image);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("wallpaper downscale failed"));
        return;
      }
      resolve({ url: URL.createObjectURL(blob), average });
    }, "image/jpeg", 0.82);
  });
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("wallpaper image failed to decode"));
    image.src = url;
  });
}

export function useTerminalWallpaperLayer(): { layer: WallpaperLayer; imageUrl: string | null } {
  const enabled = useUIStore((s) => s.terminalWallpaperEnabled);
  const source = useUIStore((s) => s.terminalWallpaperSource);
  const blur = useUIStore((s) => s.terminalWallpaperBlur);
  const veil = useUIStore((s) => s.terminalWallpaperVeil);
  const revision = useUIStore((s) => s.terminalWallpaperRevision);
  const theme = useUIStore((s) => s.theme);
  const terminalTheme = useUIStore((s) => s.terminalTheme);
  const accent = useUIStore((s) => s.accent);
  const reducedTransparency = usePrefersReducedTransparency();
  const palette = getTerminalTheme(theme, terminalTheme, accent);
  const [custom, setCustom] = useState<{ url: string; average: string } | null>(null);

  useEffect(() => {
    if (!enabled || source !== "custom") {
      setCustom(null);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    let downscaledUrl: string | null = null;
    void loadTerminalWallpaper()
      .then(async (image) => {
        if (cancelled || !image) {
          if (!cancelled) setCustom(null);
          return;
        }
        objectUrl = bytesToObjectUrl(image.bytes, image.mime);
        const decoded = await loadImage(objectUrl);
        const next = await downscale(decoded);
        downscaledUrl = next.url;
        if (cancelled) {
          URL.revokeObjectURL(next.url);
          return;
        }
        setCustom(next);
      })
      .catch(() => {
        if (!cancelled) setCustom(null);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (downscaledUrl) URL.revokeObjectURL(downscaledUrl);
    };
  }, [enabled, source, revision]);

  const layer = resolveWallpaperLayer({
    enabled,
    source,
    blur,
    veil,
    themeBackground: palette.background,
    themeForeground: palette.foreground,
    isDarkTheme: isTerminalThemeDark(terminalTheme, theme),
    reducedTransparency,
    customAverage: custom?.average,
    customReady: source === "custom" ? custom != null : undefined,
  });

  const imageUrl = !layer.active
    ? null
    : layer.source === "custom"
      ? custom?.url ?? null
      : layer.source
        ? wallpaperTextureUrl(layer.source)
        : null;

  return { layer, imageUrl };
}

export function TerminalWallpaper() {
  const { layer, imageUrl } = useTerminalWallpaperLayer();
  if (!layer.active) return null;

  return (
    <div
      aria-hidden="true"
      data-terminal-wallpaper="on"
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        pointerEvents: "none",
        zIndex: 0,
      }}
    >
      {imageUrl && (
        <div
          style={{
            position: "absolute",
            inset: "-8%",
            backgroundImage: `url("${imageUrl}")`,
            backgroundSize: layer.tile ? "180px 180px" : "cover",
            backgroundPosition: "center",
            backgroundRepeat: layer.tile ? "repeat" : "no-repeat",
            filter: `blur(${layer.blur}px)`,
          }}
        />
      )}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background: layer.veilFill,
        }}
      />
    </div>
  );
}
