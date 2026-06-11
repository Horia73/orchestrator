"use client"

import * as React from "react"

/**
 * Run `prefetch` once after mount, during browser idle time.
 *
 * Lazily-expanding list rows use this to warm their detail fetch before the
 * user taps, so the expand panel eases open with content already in the DOM —
 * no loading affordance and no sub-100ms spinner flicker. The expand animation
 * itself becomes the only feedback. Falls back to a short timeout where
 * requestIdleCallback is unavailable (older Safari).
 *
 * `prefetch` should be wrapped in useCallback and be idempotent — it is called
 * once on idle and may be called again on tap; both must be safe.
 */
export function useIdlePrefetch(prefetch: () => void) {
    React.useEffect(() => {
        if (typeof window === "undefined") return
        if (typeof window.requestIdleCallback === "function") {
            const handle = window.requestIdleCallback(prefetch, { timeout: 1200 })
            return () => window.cancelIdleCallback?.(handle)
        }
        const timer = setTimeout(prefetch, 200)
        return () => clearTimeout(timer)
    }, [prefetch])
}
