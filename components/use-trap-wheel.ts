"use client"

import * as React from "react"

const SCROLLABLE_OVERFLOW = new Set(["auto", "scroll", "overlay"])

// Nested wheel scrolling for an in-page scroll box (terminal output, tool
// result, any "casetă scrolabilă"): scroll the hovered box first, and once it
// reaches a boundary in the wheel's direction — or has nothing to scroll at all
// — hand the gesture off to the page scroll surface behind it.
//
// The handoff is driven by us (preventDefault + scrolling the outer surface
// ourselves) rather than left to the browser, because the inner box carries
// `overscroll-behavior: contain` (for touch) which also disables native wheel
// chaining. To keep that handoff from flinging the page we latch each gesture to
// whichever surface it started on — see the listener below — so the inertial
// momentum tail of a hard flick inside the box stays in the box instead of
// dumping onto the page in one fast, jerky lurch. Touch is left to CSS
// `overscroll-behavior` on the box itself; this only governs the wheel (i.e. the
// hover/desktop case).
//
// Implemented as a native, non-passive `wheel` listener in the bubble phase —
// NOT React's onWheel/onWheelCapture — for two reasons:
//   1. preventDefault() must actually cancel the browser's own scroll/chain;
//      React attaches wheel listeners as passive at the root, where
//      preventDefault is a no-op.
//   2. Capturing + stopPropagation would swallow the event before xterm's own
//      wheel handler runs, leaving the terminal unscrollable. xterm 6 scrolls
//      via its bundled VS Code scrollable element (a bubble-phase wheel
//      listener). Bubble phase lets the inner content (incl. xterm) move first;
//      we read the resulting position to decide whether to chain.
export function useTrapWheel<T extends HTMLElement>() {
    const ref = React.useRef<T>(null)
    React.useEffect(() => {
        const el = ref.current
        if (!el) return

        // Gesture latching. A continuous wheel gesture — and, on a Mac trackpad,
        // the inertial momentum tail the OS keeps firing after your fingers lift —
        // arrives as a stream of events less than LATCH_GAP_MS apart. Once the
        // inner box has scrolled during a gesture it "owns" that gesture: every
        // later event in it is swallowed instead of shoved onto the page, so the
        // momentum of a hard flick that bottoms out the box stays in the box. The
        // page only takes over when a *fresh* gesture starts with the box already
        // pinned at its boundary — and then the page owns the gesture, momentum
        // and all, exactly as a normal page scroll would. This mirrors the
        // browser's native scroll-latching, which our manual chaining replaces.
        const LATCH_GAP_MS = 200
        let lastWheelAt = 0
        let innerOwnsGesture = false

        const handleWheel = (event: WheelEvent) => {
            const axis = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? "y" : "x"
            const delta = axis === "y" ? event.deltaY : event.deltaX
            if (delta === 0) return

            const newGesture = event.timeStamp - lastWheelAt > LATCH_GAP_MS
            lastWheelAt = event.timeStamp
            if (newGesture) innerOwnsGesture = false

            // If the hovered box can still scroll in this direction, stay out of
            // the way, let it scroll natively, and latch the gesture to it.
            const inner = findScrollerInside(event.target, el, axis)
            if (inner && !isAtEdge(inner, axis, delta)) {
                innerOwnsGesture = true
                return
            }

            // The box is at its boundary (or has nothing to scroll). Always
            // preventDefault so it can never bounce the locked document.
            event.preventDefault()

            // A gesture the box already claimed keeps its momentum to itself:
            // don't fling the page with the tail of a hard flick.
            if (innerOwnsGesture) return

            // A fresh gesture that began at the edge chains to the nearest
            // scrollable surface behind us, one wheel tick at a time.
            const outer = findScrollerOutside(el, axis, delta)
            if (!outer) return
            if (axis === "y") outer.scrollTop += delta
            else outer.scrollLeft += delta
        }
        el.addEventListener("wheel", handleWheel, { passive: false })
        return () => el.removeEventListener("wheel", handleWheel)
    }, [])
    return ref
}

function isAtEdge(scroller: HTMLElement, axis: "x" | "y", delta: number): boolean {
    const position = axis === "y" ? scroller.scrollTop : scroller.scrollLeft
    const max = axis === "y"
        ? scroller.scrollHeight - scroller.clientHeight
        : scroller.scrollWidth - scroller.clientWidth
    return delta < 0 ? position <= 0 : position >= max - 1
}

function findScrollerInside(
    target: EventTarget | null,
    boundary: HTMLElement,
    axis: "x" | "y"
): HTMLElement | null {
    let node = target instanceof HTMLElement ? target : null
    while (node) {
        if (isScrollableOnAxis(node, axis)) return node
        if (node === boundary) break
        node = node.parentElement
    }
    // xterm renders its scrollable viewport as a sibling of the visible screen,
    // so walking ancestors never reaches it. Fall back to it directly.
    if (axis === "y") {
        const viewport = boundary.querySelector<HTMLElement>(".xterm-viewport")
        if (viewport && isScrollableOnAxis(viewport, "y")) return viewport
    }
    return null
}

// Walk outward from the box to the nearest ancestor that is scrollable on this
// axis and still has room to move in the wheel's direction — i.e. the page
// scroll surface. Ancestors already pinned at their own edge are skipped so the
// chain continues up, mirroring native scroll-chaining.
function findScrollerOutside(
    boundary: HTMLElement,
    axis: "x" | "y",
    delta: number
): HTMLElement | null {
    let node = boundary.parentElement
    while (node) {
        if (isScrollableOnAxis(node, axis) && !isAtEdge(node, axis, delta)) return node
        node = node.parentElement
    }
    return null
}

function isScrollableOnAxis(element: HTMLElement, axis: "x" | "y"): boolean {
    const style = window.getComputedStyle(element)
    if (axis === "y") {
        return (
            SCROLLABLE_OVERFLOW.has(style.overflowY) &&
            element.scrollHeight > element.clientHeight + 1
        )
    }
    return (
        SCROLLABLE_OVERFLOW.has(style.overflowX) &&
        element.scrollWidth > element.clientWidth + 1
    )
}
