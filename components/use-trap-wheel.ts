"use client"

import * as React from "react"

const SCROLLABLE_OVERFLOW = new Set(["auto", "scroll", "overlay"])

// Nested wheel scrolling for an in-page scroll box (terminal output, tool
// result, any "casetă scrolabilă"): scroll the hovered box first, and once it
// reaches a boundary in the wheel's direction — or has nothing to scroll at all
// — hand the gesture off to the page scroll surface behind it.
//
// The handoff is driven by us (preventDefault + a proportional scrollBy on the
// outer surface) rather than left to the browser's native scroll-chaining. That
// keeps the transition clean: each wheel tick moves the page by exactly what the
// user input, with no native momentum "dump" that would fling the page when you
// flick the inner box hard. Touch is left to CSS `overscroll-behavior` on the
// box itself; this only governs the wheel (i.e. the hover/desktop case).
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
        const handleWheel = (event: WheelEvent) => {
            const axis = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? "y" : "x"
            const delta = axis === "y" ? event.deltaY : event.deltaX
            if (delta === 0) return

            // If the hovered box can still scroll in this direction, stay out of
            // the way and let it scroll natively.
            const inner = findScrollerInside(event.target, el, axis)
            if (inner && !isAtEdge(inner, axis, delta)) return

            // The box is at its boundary (or has nothing to scroll): chain the
            // gesture to the nearest scrollable surface behind us. We always
            // preventDefault so the box can never bounce the locked document;
            // when a chainable surface exists we drive it ourselves.
            event.preventDefault()
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
