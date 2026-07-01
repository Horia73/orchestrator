"use client"

import * as React from "react"

interface PreviewZoomHandlers {
    /** Multiply the current zoom by `factor`, keeping the content point under
     *  (clientX, clientY) stationary in the viewport. */
    onZoomAt: (clientX: number, clientY: number, factor: number) => void
    /** Fires once when a two-finger touch pinch begins, before any zoom is
     *  applied — cancel in-progress pointer interactions (drawing, panning). */
    onPinchStart?: () => void
    /** Two-finger drag that accompanies a touch pinch, in client px. */
    onPinchPan?: (dx: number, dy: number) => void
}

// Translates every zoom gesture a preview viewport can receive into anchored
// onZoomAt(clientX, clientY, factor) calls:
//   - ctrl/cmd + wheel — mouse wheel zoom and Chrome/Firefox trackpad pinch
//   - Safari gesture events — macOS trackpad pinch (guarded on iOS, which
//     delivers the same pinch as touch events too)
//   - two-finger touch pinch — phones/tablets, with its accompanying pan
// The owner applies the zoom and keeps the anchor point stationary; plain
// wheel/one-finger scrolling is untouched and stays native.
export function usePreviewZoomGestures(
    ref: React.RefObject<HTMLElement | null>,
    handlers: PreviewZoomHandlers
) {
    const handlersRef = React.useRef(handlers)
    React.useEffect(() => {
        handlersRef.current = handlers
    })

    React.useEffect(() => {
        const el = ref.current
        if (!el) return

        const onWheel = (e: WheelEvent) => {
            if (!e.ctrlKey && !e.metaKey) return
            e.preventDefault()
            // Normalize to pixel deltas (line/page modes come from real mouse
            // wheels), then cap the per-event step so a single wheel notch
            // stays a comfortable increment instead of a 2x jump.
            const px = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1)
            const factor = Math.min(1.5, Math.max(2 / 3, Math.exp(-px * 0.0035)))
            handlersRef.current.onZoomAt(e.clientX, e.clientY, factor)
        }

        // Two-finger touch pinch. Implemented over touch events rather than
        // pointer events so preventDefault() can take the gesture away from the
        // browser's native pan/zoom even when the second finger lands after a
        // scroll already started.
        let pinch: { dist: number; midX: number; midY: number } | null = null
        const readPinch = (e: TouchEvent) => {
            const a = e.touches[0]
            const b = e.touches[1]
            return {
                dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
                midX: (a.clientX + b.clientX) / 2,
                midY: (a.clientY + b.clientY) / 2,
            }
        }
        const onTouchStart = (e: TouchEvent) => {
            if (e.touches.length !== 2) return
            pinch = readPinch(e)
            handlersRef.current.onPinchStart?.()
        }
        const onTouchMove = (e: TouchEvent) => {
            if (!pinch || e.touches.length < 2) return
            e.preventDefault()
            const next = readPinch(e)
            handlersRef.current.onPinchPan?.(next.midX - pinch.midX, next.midY - pinch.midY)
            if (pinch.dist > 0) handlersRef.current.onZoomAt(next.midX, next.midY, next.dist / pinch.dist)
            pinch = next
        }
        const onTouchEnd = (e: TouchEvent) => {
            if (e.touches.length < 2) pinch = null
        }

        // Safari-only gesture events. On macOS this is the only signal a
        // trackpad pinch produces; on iOS the pinch already arrived as touch
        // events above, so only preventDefault (suppressing Safari's own page
        // zoom) and skip the zoom itself.
        let lastGestureScale = 1
        const onGestureStart = (e: Event) => {
            e.preventDefault()
            lastGestureScale = 1
        }
        const onGestureChange = (e: Event) => {
            e.preventDefault()
            if (pinch) return
            const g = e as Event & { scale?: number; clientX?: number; clientY?: number }
            if (!g.scale) return
            // `scale` is cumulative since gesturestart — convert to a per-event factor.
            const factor = g.scale / lastGestureScale
            lastGestureScale = g.scale
            const rect = el.getBoundingClientRect()
            const cx = typeof g.clientX === "number" ? g.clientX : rect.left + rect.width / 2
            const cy = typeof g.clientY === "number" ? g.clientY : rect.top + rect.height / 2
            handlersRef.current.onZoomAt(cx, cy, factor)
        }

        el.addEventListener("wheel", onWheel, { passive: false })
        el.addEventListener("touchstart", onTouchStart, { passive: true })
        el.addEventListener("touchmove", onTouchMove, { passive: false })
        el.addEventListener("touchend", onTouchEnd, { passive: true })
        el.addEventListener("touchcancel", onTouchEnd, { passive: true })
        el.addEventListener("gesturestart", onGestureStart, { passive: false } as AddEventListenerOptions)
        el.addEventListener("gesturechange", onGestureChange, { passive: false } as AddEventListenerOptions)
        return () => {
            el.removeEventListener("wheel", onWheel)
            el.removeEventListener("touchstart", onTouchStart)
            el.removeEventListener("touchmove", onTouchMove)
            el.removeEventListener("touchend", onTouchEnd)
            el.removeEventListener("touchcancel", onTouchEnd)
            el.removeEventListener("gesturestart", onGestureStart)
            el.removeEventListener("gesturechange", onGestureChange)
        }
    }, [ref])
}
