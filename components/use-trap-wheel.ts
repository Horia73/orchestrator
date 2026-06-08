"use client"

import * as React from "react"

const SCROLLABLE_OVERFLOW = new Set(["auto", "scroll", "overlay"])

// Keep a scroll surface's wheel gesture inside its own box: scroll its content,
// but never chain out to the page behind it once it hits a boundary (or when
// there's nothing to scroll at all).
//
// Implemented as a native, non-passive `wheel` listener in the bubble phase —
// NOT React's onWheel/onWheelCapture — for two reasons:
//   1. preventDefault() must actually cancel the scroll; React attaches wheel
//      listeners as passive at the root, where preventDefault is a no-op.
//   2. Capturing + stopPropagation would swallow the event before xterm's own
//      wheel handler runs, leaving the terminal unscrollable. xterm 6 scrolls
//      via its bundled VS Code scrollable element (a bubble-phase wheel
//      listener), and its `.xterm-viewport` no longer overflows natively — so
//      any capture-phase stopPropagation kills wheel scrolling even though
//      dragging the scrollbar slider (a separate pointer gesture) still works.
//      Bubble phase lets the inner content (incl. xterm) scroll first; we only
//      block the chain.
export function useTrapWheel<T extends HTMLElement>() {
    const ref = React.useRef<T>(null)
    React.useEffect(() => {
        const el = ref.current
        if (!el) return
        const handleWheel = (event: WheelEvent) => {
            const axis = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? "y" : "x"
            const scroller = findScrollerInside(event.target, el, axis)
            if (!scroller) {
                event.preventDefault()
                return
            }
            const delta = axis === "y" ? event.deltaY : event.deltaX
            if (delta === 0) return
            const position = axis === "y" ? scroller.scrollTop : scroller.scrollLeft
            const max = axis === "y"
                ? scroller.scrollHeight - scroller.clientHeight
                : scroller.scrollWidth - scroller.clientWidth
            if ((delta < 0 && position <= 0) || (delta > 0 && position >= max - 1)) {
                event.preventDefault()
            }
        }
        el.addEventListener("wheel", handleWheel, { passive: false })
        return () => el.removeEventListener("wheel", handleWheel)
    }, [])
    return ref
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
