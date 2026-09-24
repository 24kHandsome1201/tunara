import { PanelLoadingState } from "../shared";

/**
 * Suspense fallback for lazily loaded modal overlays (Settings, SSH Connect).
 * Fixed and pointer-transparent so the first open never pushes the app shell
 * around; the label fades in only after a short delay, so a fast chunk load
 * shows nothing at all.
 */
export function OverlayLoadingFallback({ label }: { label: string }) {
  return (
    <div
      className="overlay-loading-fallback"
      data-testid="overlay-loading-fallback"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 300,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        pointerEvents: "none",
      }}
    >
      <PanelLoadingState label={label} />
    </div>
  );
}
