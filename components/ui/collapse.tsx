"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

// useLayoutEffect on the server warns; these panels only render client-side
// (after data loads) but stay safe everywhere.
const useIsomorphicLayoutEffect =
    typeof window !== "undefined" ? React.useLayoutEffect : React.useEffect

/**
 * Height-animated collapse for lazily-revealed panels.
 *
 * Animates an explicit pixel height (0 ↔ measured content height) rather than
 * the CSS grid `0fr→1fr` trick: fr-track interpolation isn't supported on older
 * Safari and renders unreliably in some Chromium builds, snapping the panel
 * open with no motion. Two definite pixel endpoints interpolate in every
 * browser and need no requestAnimationFrame. A ResizeObserver keeps the open
 * height in sync when the content reflows (late content, window resize).
 *
 * Callers mount their rows closed, so the first render is height 0 with nothing
 * to animate; the content lives in the DOM the whole time (clipped) so the very
 * first open eases straight from 0 to the real height.
 */
export function Collapse({
    open,
    children,
    className,
}: {
    open: boolean
    children: React.ReactNode
    className?: string
}) {
    const innerRef = React.useRef<HTMLDivElement>(null)
    const [height, setHeight] = React.useState(0)

    useIsomorphicLayoutEffect(() => {
        const inner = innerRef.current
        if (!inner) return
        if (!open) {
            setHeight(0)
            return
        }
        setHeight(inner.scrollHeight)
        const observer = new ResizeObserver(() => setHeight(inner.scrollHeight))
        observer.observe(inner)
        return () => observer.disconnect()
    }, [open])

    return (
        <div
            className={cn(
                "overflow-hidden transition-[height] duration-300 ease-out motion-reduce:transition-none",
                className,
            )}
            style={{ height }}
            aria-hidden={!open}
        >
            <div ref={innerRef}>{children}</div>
        </div>
    )
}
