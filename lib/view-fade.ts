// Single source of truth for the view crossfade length.
//
// Must stay in sync with the `transition-opacity duration-150` utility on the
// view shells (app/page.tsx, components/inbox/inbox-view.tsx). It is both the
// CSS fade length and the delay the sidebar holds before navigating away, so a
// leaving view finishes its fade-out before the route swaps.
export const VIEW_FADE_MS = 150

// Window event fired when a view should fade itself out ahead of a route
// change (so the departing view eases out instead of hard-cutting to the next
// route's loading boundary). The view that owns the fade shell listens for it.
export const VIEW_LEAVE_EVENT = "orchestrator:view-leave"
