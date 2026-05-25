import type { RecipeIngredient } from './schema'

/**
 * Culinary scaling utilities for ingredient amounts when the user changes the
 * servings stepper.
 *
 * The goal is "what a home cook would naturally write down", not raw
 * mathematical precision:
 *
 *   - Sub-unit amounts (< 1) keep 2 decimals: 0.25 tsp, 0.5 cățel.
 *   - Small amounts (< 10) keep 1 decimal: 2.5 g, 7.5 ml.
 *   - Mid amounts (< 100) round to nearest 0.5: 47.5 g, 22 g.
 *   - Large amounts (>= 100) round to nearest whole number: 167 g, 800 ml.
 *
 * No conversion happens — `unit` is preserved as-is. We're metric-only by
 * design (see {@link RecipeUnitSchema}).
 */
export function scaleAmount(amount: number, ratio: number): number {
    if (!Number.isFinite(amount) || !Number.isFinite(ratio) || ratio <= 0) {
        return amount
    }
    const scaled = amount * ratio
    if (scaled < 1) return roundTo(scaled, 0.01)
    if (scaled < 10) return roundTo(scaled, 0.1)
    if (scaled < 100) return roundTo(scaled, 0.5)
    return Math.round(scaled)
}

function roundTo(n: number, step: number): number {
    const inv = 1 / step
    return Math.round(n * inv) / inv
}

/**
 * Render a numeric amount as a human-readable string with trailing zeros
 * trimmed. `47.5` → "47.5", `100` → "100", `0.25` → "0.25".
 */
export function formatAmount(amount: number): string {
    if (!Number.isFinite(amount)) return ''
    // Avoid floating-point artifacts like 0.30000000000000004 surfacing.
    const rounded = Math.round(amount * 100) / 100
    if (rounded % 1 === 0) return String(rounded)
    return rounded.toString()
}

/**
 * Compute the displayed amount for an ingredient at the current servings
 * ratio. Returns `null` when the ingredient has no numeric amount (e.g.
 * "sare după gust") or when it's flagged non-scaleable — caller renders
 * the original amount in those cases.
 */
export function scaledIngredientAmount(
    ingredient: RecipeIngredient,
    ratio: number,
): number | null {
    if (ingredient.amount === undefined) return null
    if (ingredient.scaleable === false) return ingredient.amount
    return scaleAmount(ingredient.amount, ratio)
}
