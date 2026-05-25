import { interpolateScalableQuantities } from './interpolate'
import type { RecipeArtifact, RecipeIngredient } from './schema'
import { formatAmount, scaledIngredientAmount } from './scale'

/**
 * Render a recipe as plain markdown. Used by the Copy button to put a
 * paste-friendly version on the clipboard.
 *
 * The output mirrors the on-screen layout so a user pasting into Notion,
 * Apple Notes, or a Markdown editor gets the same structure they saw — title,
 * meta line, ingredients section (with current servings already applied),
 * numbered steps with optional `(timer: mm:ss)` annotations, and notes.
 *
 * `servings` is the CURRENT value from the stepper — defaults to the recipe's
 * default if the caller wants the as-published version. Ingredient amounts
 * scale accordingly.
 */
export function recipeToMarkdown(
    recipe: RecipeArtifact,
    options: { servings?: number } = {},
): string {
    const currentServings = options.servings ?? recipe.servings.default
    const ratio = currentServings / recipe.servings.default

    const lines: string[] = []
    lines.push(`# ${recipe.title}`)
    if (recipe.subtitle) {
        lines.push('')
        lines.push(`_${recipe.subtitle}_`)
    }

    const metaBits = buildMetaBits(recipe, currentServings)
    if (metaBits.length > 0) {
        lines.push('')
        lines.push(metaBits.join(' · '))
    }

    // Ingredients — grouped by `group` to mirror the renderer.
    lines.push('')
    lines.push('## Ingrediente')
    const groups = groupIngredients(recipe.ingredients)
    for (const group of groups) {
        if (group.heading) {
            lines.push('')
            lines.push(`**${group.heading}**`)
        }
        for (const ing of group.items) {
            lines.push(`- ${formatIngredientLine(ing, ratio)}`)
        }
    }

    // Steps — numbered, with optional inline timer annotation. Inline
    // `{{N unit}}` tokens are interpolated against the current ratio so the
    // copied markdown matches what's on screen.
    lines.push('')
    lines.push('## Pași')
    recipe.steps.forEach((step, idx) => {
        const num = idx + 1
        const title = step.title ? interpolateScalableQuantities(step.title, ratio) : null
        const head = title ? `**${title}.** ` : ''
        const body = interpolateScalableQuantities(step.body, ratio)
        const timer = step.timerSeconds !== undefined
            ? ` _(cronometru: ${formatTimerHint(step.timerSeconds)})_`
            : ''
        lines.push(`${num}. ${head}${body}${timer}`)
    })

    // Notes.
    if (recipe.notes?.length) {
        lines.push('')
        lines.push('## Notițe')
        for (const block of recipe.notes) {
            if (block.heading) {
                lines.push('')
                lines.push(`**${block.heading}**`)
            }
            for (const bullet of block.bullets) {
                lines.push(`- ${interpolateScalableQuantities(bullet, ratio)}`)
            }
        }
    }

    if (recipe.attribution) {
        lines.push('')
        lines.push(`_Sursă: ${recipe.attribution}_`)
    }

    return lines.join('\n') + '\n'
}

function buildMetaBits(recipe: RecipeArtifact, servings: number): string[] {
    const bits: string[] = []
    bits.push(`${servings} ${recipe.servings.unitLabel ?? 'porții'}`)
    const total = recipe.totalMinutes
        ?? ((recipe.prepMinutes ?? 0) + (recipe.cookMinutes ?? 0) || undefined)
    if (total !== undefined && total > 0) {
        bits.push(formatMinutes(total))
    }
    if (recipe.difficulty) {
        bits.push(DIFFICULTY[recipe.difficulty])
    }
    return bits
}

function formatIngredientLine(ing: RecipeIngredient, ratio: number): string {
    const scaled = scaledIngredientAmount(ing, ratio)
    const noteSuffix = ing.note ? ` _(${ing.note})_` : ''
    if (scaled === null) {
        return `${ing.name}${noteSuffix}`
    }
    const unit = ing.unit ? ` ${ing.unit}` : ''
    return `${formatAmount(scaled)}${unit} ${ing.name}${noteSuffix}`
}

function groupIngredients(
    ingredients: RecipeIngredient[],
): Array<{ heading?: string; items: RecipeIngredient[] }> {
    const out: Array<{ heading?: string; items: RecipeIngredient[] }> = []
    for (const ing of ingredients) {
        const last = out[out.length - 1]
        if (last && last.heading === ing.group) {
            last.items.push(ing)
        } else {
            out.push({ heading: ing.group, items: [ing] })
        }
    }
    return out
}

function formatMinutes(min: number): string {
    if (min < 60) return `${min} min`
    const h = Math.floor(min / 60)
    const m = min % 60
    if (m === 0) return `${h} h`
    return `${h} h ${m} min`
}

function formatTimerHint(seconds: number): string {
    const s = Math.floor(seconds % 60)
    const m = Math.floor((seconds / 60) % 60)
    const h = Math.floor(seconds / 3600)
    const pad = (n: number) => n.toString().padStart(2, '0')
    if (h > 0) return `${h}:${pad(m)}:${pad(s)}`
    return `${m}:${pad(s)}`
}

const DIFFICULTY: Record<NonNullable<RecipeArtifact['difficulty']>, string> = {
    usor: 'Ușor',
    mediu: 'Mediu',
    greu: 'Greu',
}
