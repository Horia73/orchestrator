/**
 * Burn-rate projection for CLI subscription quota windows.
 *
 * Mirrors what codex's `/status` panel shows under each limit: given how much
 * of a window is spent vs. how far into the window we are, project when the
 * window will hit 100% if usage continues at the average rate so far, and
 * frame the gap from even pacing as a "deficit" (ahead, will run out early) or
 * "reserve" (behind, banked headroom).
 *
 * This is an even-pacing model — a pure function of the current snapshot, no
 * historical samples needed:
 *   elapsedFraction = (now - windowStart) / windowLength
 *   used > elapsed  → ahead of pace; runsOutAt = now + elapsed·(1-used)/used
 *   used ≤ elapsed  → behind pace; lasts until reset
 *
 * (Note: runsOutAt < resetsAt is algebraically equivalent to used > elapsed,
 * so the two framings never disagree.)
 *
 * Pure and client-safe: no imports from ./usage, which pulls in node-pty.
 */

export const FIVE_HOUR_SECONDS = 5 * 60 * 60
export const WEEKLY_SECONDS = 7 * 24 * 60 * 60

export type QuotaPaceMode = "deficit" | "reserve" | "exhausted" | "unknown"

export interface QuotaPace {
    mode: QuotaPaceMode
    /** Percentage points above (deficit) or below (reserve) an even burn rate. >= 0. */
    deltaPercent: number
    /** Unix seconds the window is projected to hit 100% at the current rate. Set only when mode === "deficit". */
    runsOutAt: number | null
}

interface QuotaWindowInput {
    usedPercent: number
    resetsAt: number
    /** Authoritative window length when the source provides it (Codex). Falls back to the per-field constant otherwise. */
    windowSeconds?: number
}

export function computeQuotaPace(
    window: QuotaWindowInput,
    fallbackWindowSeconds: number,
    nowSeconds: number = Math.floor(Date.now() / 1000)
): QuotaPace {
    const windowSeconds = window.windowSeconds && window.windowSeconds > 0
        ? window.windowSeconds
        : fallbackWindowSeconds
    const used = clamp01(window.usedPercent / 100)
    const resetsAt = window.resetsAt

    // No usable reset time, or the window has already rolled over → the % we
    // hold is stale and pacing is meaningless.
    if (!Number.isFinite(resetsAt) || resetsAt <= nowSeconds || windowSeconds <= 0) {
        return { mode: "unknown", deltaPercent: 0, runsOutAt: null }
    }
    if (used >= 1) {
        return { mode: "exhausted", deltaPercent: 0, runsOutAt: nowSeconds }
    }

    const elapsed = nowSeconds - (resetsAt - windowSeconds)
    // Window hasn't started yet or clock skew — projection undefined.
    if (elapsed <= 0) {
        return { mode: "unknown", deltaPercent: 0, runsOutAt: null }
    }
    const elapsedFraction = clamp01(elapsed / windowSeconds)

    if (used <= 0) {
        return { mode: "reserve", deltaPercent: round1(elapsedFraction * 100), runsOutAt: null }
    }
    if (used > elapsedFraction) {
        const secondsToExhaust = (elapsed * (1 - used)) / used
        return {
            mode: "deficit",
            deltaPercent: round1((used - elapsedFraction) * 100),
            runsOutAt: nowSeconds + secondsToExhaust,
        }
    }
    return { mode: "reserve", deltaPercent: round1((elapsedFraction - used) * 100), runsOutAt: null }
}

export interface QuotaPaceLabel {
    text: string
    tone: "danger" | "warn" | "muted"
}

/**
 * Compute + describe in one call. Reads the clock internally so React render
 * paths can call it without an impure `Date.now()` in the component body.
 */
export function quotaPaceLabel(
    window: QuotaWindowInput,
    fallbackWindowSeconds: number,
    nowSeconds: number = Math.floor(Date.now() / 1000)
): QuotaPaceLabel | null {
    return describeQuotaPace(computeQuotaPace(window, fallbackWindowSeconds, nowSeconds), nowSeconds)
}

/** Human phrase + tone for a pace result, or null when there's nothing useful to say. */
export function describeQuotaPace(pace: QuotaPace, nowSeconds: number): QuotaPaceLabel | null {
    if (pace.mode === "unknown") return null
    if (pace.mode === "exhausted") return { text: "Limit reached", tone: "danger" }
    if (pace.mode === "deficit" && pace.runsOutAt != null) {
        const dur = formatCompactDuration(pace.runsOutAt - nowSeconds)
        const over = pace.deltaPercent >= 1 ? ` · ${Math.round(pace.deltaPercent)}% over pace` : ""
        return { text: `Runs out in ${dur}${over}`, tone: "warn" }
    }
    const reserve = pace.deltaPercent >= 1 ? `${Math.round(pace.deltaPercent)}% in reserve · ` : ""
    return { text: `${reserve}lasts until reset`, tone: "muted" }
}

export function formatCompactDuration(seconds: number): string {
    const s = Math.max(0, Math.floor(seconds))
    if (s <= 0) return "now"
    const d = Math.floor(s / 86400)
    const h = Math.floor((s % 86400) / 3600)
    const m = Math.floor((s % 3600) / 60)
    if (d >= 1) return h > 0 ? `${d}d ${h}h` : `${d}d`
    if (h >= 1) return m > 0 ? `${h}h ${m}m` : `${h}h`
    return `${Math.max(1, m)}m`
}

/**
 * Countdown to a window reset, phrased identically for the chat popover and
 * the settings usage tab: "resets in 2d 12h" / "resets in 7h 39m" / "resets
 * in 45m". Rolls hours up into days (31h39m → "1d 7h") instead of flooring to
 * whole days or rounding, so the two surfaces never disagree.
 */
export function formatResetCountdown(
    resetsAt: number,
    nowSeconds: number = Math.floor(Date.now() / 1000)
): string {
    if (!resetsAt || !Number.isFinite(resetsAt)) return "reset time unknown"
    const delta = resetsAt - nowSeconds
    // A reset moment in the past means the window already cycled — the % we
    // hold is from before that point, so it's stale.
    if (delta <= 0) return "window rolled over"
    return `resets in ${formatCompactDuration(delta)}`
}

function clamp01(n: number): number {
    if (!Number.isFinite(n)) return 0
    return Math.max(0, Math.min(1, n))
}

function round1(n: number): number {
    return Math.round(n * 10) / 10
}
