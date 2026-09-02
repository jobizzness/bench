import { useEffect } from "react";

/**
 * `100dvh` tracks a phone browser's toolbars, but not every browser shrinks
 * it for the soft keyboard the way Chrome does - on iOS Safari the layout
 * viewport (what `dvh` measures) stays put and the keyboard simply covers
 * whatever is under it. `window.visualViewport` does shrink there, so this
 * mirrors its height onto a custom property and leaves `#app` to fall back
 * to `100dvh` wherever the property isn't set - which is every browser
 * without the API, and, by the stylesheet's own choice, every width above
 * the mobile breakpoint. See `#app` in styles.css.
 */
export function useVisualViewportHeight(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const sync = () => {
      document.documentElement.style.setProperty("--visual-viewport-height", `${viewport.height}px`);
    };
    sync();
    viewport.addEventListener("resize", sync);
    viewport.addEventListener("scroll", sync);
    return () => {
      viewport.removeEventListener("resize", sync);
      viewport.removeEventListener("scroll", sync);
      document.documentElement.style.removeProperty("--visual-viewport-height");
    };
  }, []);
}
