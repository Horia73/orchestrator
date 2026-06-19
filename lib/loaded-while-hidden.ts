// True when this page's JavaScript first ran while the tab was backgrounded
// (the document was `hidden` at load). On mobile, iOS routinely discards and
// reloads a backgrounded PWA/tab, so "coming back to the app" is in fact a
// cold reload that completed while hidden. Captured once at module evaluation
// — the first script execution on the fresh document — so it describes the
// load itself, not later foreground/background flips.
//
// Why it matters: the chat's reveal (splash exit, shell crossfade, message
// list fade) is gated on the scroll-restore finishing, which is driven by
// `requestAnimationFrame` and therefore suspended while the tab is hidden. So
// on a background reload the whole reveal sequence is blocked until the user
// returns, then plays out in front of them — the conversation animates in
// instead of simply being there. Consumers use this flag to reveal the
// already-settled chat instantly on return: no splash, no fades, no movement.
//
// Read it through a layout effect (not a render initializer) so the first
// render still matches the server (where `document` is undefined) and there is
// no hydration mismatch — the effect runs before the first paint, which on a
// background reload only happens once the tab is foregrounded.
export const LOADED_WHILE_HIDDEN =
  typeof document !== "undefined" && document.visibilityState === "hidden"
