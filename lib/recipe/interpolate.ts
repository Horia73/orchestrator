import { formatAmount, scaleAmount } from './scale'

/**
 * In-body quantity interpolation for recipe step text.
 *
 * Problem: a recipe body often mentions numeric quantities that depend on
 * ingredient amounts but live OUTSIDE the ingredient list — e.g. "păstrează
 * 120 ml din apa de la paste" or "adaugă 2-3 linguri de zahăr". If the user
 * changes servings, the ingredient quantities scale but those literal numbers
 * in the step text don't, leaving the recipe internally inconsistent.
 *
 * Solution: the model wraps any scaleable quantity in step bodies (and step
 * titles, notes bullets, etc.) in `{{...}}`. The renderer interpolates these
 * with the current ratio just before handing the text to markdown:
 *
 *   "{{120 ml}} apă"        @ ratio=2  → "240 ml apă"
 *   "{{2-3 linguri}} zahăr" @ ratio=2  → "4-6 linguri zahăr"
 *   "1 minut" (no braces)   @ any      → "1 minut"  (untouched — time)
 *
 * Anything that can't be parsed as `<number>[-–<number>] <unit>` is left
 * verbatim so the model can't accidentally damage prose with stray braces.
 */
export function interpolateScalableQuantities(text: string, ratio: number): string {
    if (!text.includes('{{')) return text
    // We match `{{ ... }}` with a non-greedy body that forbids newlines so a
    // stray opening `{{` doesn't swallow paragraphs of text.
    return text.replace(/\{\{([^{}\n]+)\}\}/g, (whole, inner: string) => {
        const replaced = interpolateOne(inner.trim(), ratio)
        return replaced ?? whole
    })
}

const QUANTITY_RE =
    /^(\d+(?:[.,]\d+)?)(?:\s*[-–—]\s*(\d+(?:[.,]\d+)?))?\s+(\S[\s\S]*?)\s*$/

function interpolateOne(expr: string, ratio: number): string | null {
    const match = QUANTITY_RE.exec(expr)
    if (!match) return null

    const lo = parseNumber(match[1])
    const hi = match[2] !== undefined ? parseNumber(match[2]) : null
    const trailing = match[3]

    if (lo === null || (match[2] !== undefined && hi === null)) return null

    const scaledLo = scaleAmount(lo, ratio)
    if (hi !== null) {
        const scaledHi = scaleAmount(hi, ratio)
        return `${formatAmount(scaledLo)}–${formatAmount(scaledHi)} ${trailing}`
    }
    return `${formatAmount(scaledLo)} ${trailing}`
}

function parseNumber(s: string): number | null {
    const n = Number.parseFloat(s.replace(',', '.'))
    return Number.isFinite(n) ? n : null
}
