/**
 * One-rep max (1RM) estimation.
 *
 * Two classic formulas — Epley and Brzycki — give very close numbers at
 * normal rep ranges (1..10) and diverge at extremes (15+ reps). We expose
 * both and the average; the renderer uses the average as the displayed
 * estimated 1RM.
 *
 *   Epley:   1RM = w × (1 + r / 30)
 *   Brzycki: 1RM = w × 36 / (37 - r)        — undefined at r = 37
 *
 * For r = 1 both return the lifted weight exactly. For r > 36 Brzycki
 * blows up; we clamp inputs and return null when the answer would be
 * meaningless rather than NaN/Infinity. The renderer hides 1RM display
 * when this returns null.
 */

/** Epley's formula. Linear in reps. */
export function epley1RM(weightKg: number, reps: number): number | null {
    if (!Number.isFinite(weightKg) || !Number.isFinite(reps)) return null
    if (weightKg <= 0 || reps <= 0) return null
    return weightKg * (1 + reps / 30)
}

/** Brzycki's formula. Diverges past r=36. */
export function brzycki1RM(weightKg: number, reps: number): number | null {
    if (!Number.isFinite(weightKg) || !Number.isFinite(reps)) return null
    if (weightKg <= 0 || reps <= 0) return null
    if (reps >= 37) return null
    return (weightKg * 36) / (37 - reps)
}

/**
 * Average of Epley + Brzycki, rounded to the nearest 0.5 kg. This is the
 * "estimated 1RM" we display in the UI. Returns null when either input is
 * invalid or when the rep count is so high that Brzycki is undefined.
 *
 * Above ~15 reps the two formulas disagree more than 5%; we still return
 * a number but the model should generally avoid showing 1RM for such sets.
 */
export function estimated1RM(weightKg: number, reps: number): number | null {
    if (!Number.isFinite(weightKg) || !Number.isFinite(reps)) return null
    if (weightKg <= 0 || reps <= 0) return null
    // r=1 is by definition the lifted weight. Skip the formulas — Epley's
    // linear term yields w × 1.033 at r=1, which double-counts the rep
    // we already performed at that weight.
    if (reps === 1) return Math.round(weightKg * 2) / 2
    const e = epley1RM(weightKg, reps)
    const b = brzycki1RM(weightKg, reps)
    if (e === null || b === null) return null
    return Math.round((e + b) / 2 * 2) / 2
}

/**
 * Invert the formula: given a target 1RM and a rep count, what weight do
 * you load? Uses the average of Epley and Brzycki inverses, rounded to
 * 0.5 kg. Useful for percentage-based programs (Stronglifts, 5/3/1).
 */
export function weightForReps(target1RM: number, reps: number): number | null {
    if (!Number.isFinite(target1RM) || !Number.isFinite(reps)) return null
    if (target1RM <= 0 || reps <= 0 || reps >= 37) return null
    const wEpley = target1RM / (1 + reps / 30)
    const wBrzycki = (target1RM * (37 - reps)) / 36
    return Math.round((wEpley + wBrzycki) / 2 * 2) / 2
}
