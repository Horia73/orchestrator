/**
 * True when the current viewport is desktop-sized (>= the mobile breakpoint).
 *
 * Used to scope render-timing tweaks that are safe and desirable on desktop but
 * would regress mobile conversation-open performance — e.g. measuring a
 * collapsible message before paint, or syntax-highlighting code eagerly instead
 * of on idle. Returns false during SSR. Re-checked at call time so it follows a
 * window resize across the breakpoint.
 */
export function isDesktopViewport(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(min-width: 768px)").matches
  )
}
