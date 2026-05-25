/**
 * Plate calculator.
 *
 * Given a target loaded weight, a bar weight, and the plates the user owns,
 * return the minimal set of plates to load on ONE side (the user loads the
 * mirror on the other side). Returns `null` if the target is below the bar
 * weight or if the remainder can't be expressed with the available plates.
 *
 * Default plate set: standard EU metric (25, 20, 15, 10, 5, 2.5, 1.25 kg).
 * Micro plates (0.5, 0.25) can be added when the user owns them.
 *
 * Algorithm: greedy, largest-plate-first. Optimal for the typical plate
 * stack because each smaller plate is < 2× the next (so no greedy trap).
 */

const DEFAULT_PLATES_KG = [25, 20, 15, 10, 5, 2.5, 1.25] as const
const DEFAULT_BAR_WEIGHT_KG = 20

export interface PlatePlan {
    /** The total target weight loaded on the bar (input). */
    targetKg: number
    /** Bar weight used. */
    barKg: number
    /** Plates loaded on ONE side, descending. */
    perSide: number[]
    /** Sum of `perSide` × 2 + bar — should equal `targetKg` exactly. */
    actualKg: number
    /** If the requested target couldn't be hit exactly with available plates,
     *  this is the gap (targetKg - actualKg). Positive means we under-loaded. */
    remainderKg: number
}

/**
 * Calculate plates needed per side. Returns the closest achievable plan;
 * if exact, `remainderKg` is 0. If the target is below the bar weight,
 * returns null. If no plates can contribute (e.g. target = bar + 0.3 with
 * no micro plates), returns the plan with `perSide: []` and the gap.
 *
 * @param targetKg The total weight including bar to be lifted.
 * @param options Optional bar weight and plate set overrides.
 */
export function calculatePlates(
    targetKg: number,
    options: {
        barKg?: number
        availablePlatesKg?: readonly number[]
    } = {},
): PlatePlan | null {
    if (!Number.isFinite(targetKg) || targetKg < 0) return null

    const barKg = options.barKg ?? DEFAULT_BAR_WEIGHT_KG
    if (targetKg < barKg) return null

    // Sort descending — greedy needs largest first.
    const plates = (options.availablePlatesKg ?? DEFAULT_PLATES_KG)
        .filter((p) => p > 0 && Number.isFinite(p))
        .slice()
        .sort((a, b) => b - a)

    // Per-side load needed: (target - bar) / 2.
    let perSideRemaining = (targetKg - barKg) / 2
    const perSide: number[] = []

    // Tolerance for floating point: 0.001 kg.
    const eps = 0.001

    for (const plate of plates) {
        // Use this plate as many times as it fits.
        while (perSideRemaining + eps >= plate) {
            perSide.push(plate)
            perSideRemaining -= plate
        }
    }

    const loaded = perSide.reduce((s, p) => s + p, 0)
    const actualKg = barKg + loaded * 2
    const remainderKg = Math.round((targetKg - actualKg) * 1000) / 1000

    return {
        targetKg,
        barKg,
        perSide,
        actualKg,
        remainderKg,
    }
}

/**
 * Format a plate plan as a compact human string for display.
 * Examples:
 *   "20 + 5 + 2.5 per side" (loaded)
 *   "bar only"               (target = bar)
 *   "20 + 5 + 2.5 per side · 0.3 kg short" (with remainder)
 */
export function formatPlatePlan(plan: PlatePlan): string {
    if (plan.perSide.length === 0) {
        const base = plan.targetKg === plan.barKg ? 'bar only' : 'bar only'
        if (Math.abs(plan.remainderKg) > 0.001) {
            return `${base} · ${formatNumber(Math.abs(plan.remainderKg))} kg ${plan.remainderKg > 0 ? 'short' : 'over'}`
        }
        return base
    }
    // Collapse duplicates: "20+20+5" → "20×2 + 5"
    const counts = new Map<number, number>()
    for (const p of plan.perSide) counts.set(p, (counts.get(p) ?? 0) + 1)
    const parts = [...counts.entries()].map(([plate, n]) =>
        n === 1 ? formatNumber(plate) : `${formatNumber(plate)}×${n}`,
    )
    let str = `${parts.join(' + ')} per side`
    if (Math.abs(plan.remainderKg) > 0.001) {
        str += ` · ${formatNumber(Math.abs(plan.remainderKg))} kg ${plan.remainderKg > 0 ? 'short' : 'over'}`
    }
    return str
}

function formatNumber(n: number): string {
    if (Number.isInteger(n)) return n.toString()
    return n.toFixed(2).replace(/\.?0+$/, '')
}

export const DEFAULT_PLATES = DEFAULT_PLATES_KG
export const DEFAULT_BAR_WEIGHT = DEFAULT_BAR_WEIGHT_KG
