/**
 * Smoke test for the recipe artifact foundation.
 *
 * Validates the pure-logic pieces of Step 1:
 *   - Schema parses minimal and rich valid inputs.
 *   - Schema rejects malformed inputs with a useful error path:
 *       - non-metric units
 *       - amount/unit asymmetry
 *       - bad servings min/max ordering
 *       - empty ingredients/steps
 *       - invalid image URL
 *   - scaleAmount applies culinary rounding across magnitudes.
 *   - scaledIngredientAmount honors `scaleable: false` and missing amounts.
 *   - formatAmount strips trailing zeros and handles whole numbers.
 *
 * No network. The renderer is exercised by browser preview later.
 *
 * Run: npx tsx scripts/smoke-recipe-parser.ts
 */
import { parseRecipeArtifact } from '@/lib/recipe/parser'
import {
    formatAmount,
    scaleAmount,
    scaledIngredientAmount,
} from '@/lib/recipe/scale'
import type { RecipeIngredient } from '@/lib/recipe/schema'

let failures = 0
function check(label: string, cond: unknown, detail?: unknown) {
    const ok = Boolean(cond)
    console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  (' + JSON.stringify(detail) + ')'}`)
    if (!ok) failures++
}

// --- schema: minimal valid -------------------------------------------------

const minimal = {
    title: 'Pâine simplă',
    servings: { default: 1 },
    ingredients: [
        { amount: 500, unit: 'g', name: 'făină' },
    ],
    steps: [
        { body: 'Amestecă, frământă, lasă să crească, coace 40 de minute.' },
    ],
}
{
    const r = parseRecipeArtifact(JSON.stringify(minimal))
    check('schema: minimal recipe parses', r.ok, r)
    if (r.ok) {
        check('schema: title preserved', r.value.title === 'Pâine simplă')
        check('schema: scaleable defaults to true', r.value.ingredients[0].scaleable === true)
        check('schema: optional fields stay undefined', r.value.subtitle === undefined && r.value.notes === undefined)
    }
}

// --- schema: rich valid ----------------------------------------------------

const rich = {
    title: "Penne all'Arrabbiata",
    subtitle: 'Clasica pastă romană picantă — cu roșii proaspete, de la zero.',
    servings: { default: 4, min: 1, max: 12, unitLabel: 'porții' },
    prepMinutes: 15,
    cookMinutes: 30,
    totalMinutes: 45,
    difficulty: 'usor',
    imageQuery: 'penne arrabbiata fresh tomatoes',
    images: [
        { url: 'https://example.com/penne1.jpg', attribution: 'retetefeldefel', sourceUrl: 'https://example.com/r' },
    ],
    ingredients: [
        { amount: 400, unit: 'g', name: 'penne rigate' },
        { amount: 800, unit: 'g', name: 'roșii coapte', note: 'tip Roma sau San Marzano proaspete' },
        { amount: 4, unit: 'catei', name: 'usturoi' },
        { amount: 2, unit: 'bucata', name: 'ardei iute uscat (peperoncino)', scaleable: false },
        { amount: 75, unit: 'ml', name: 'ulei de măsline extravirgin' },
        { name: 'sare după gust' },
    ],
    steps: [
        { title: 'Opărește roșiile', body: 'Incizează un X pe fundul fiecărei roșii.' },
        { title: 'Sotează usturoiul', body: 'Adaugă usturoiul în ulei și sotează.', timerSeconds: 150 },
        { title: 'Finalizează', body: 'Combină pastele cu sosul.', timerSeconds: 90 },
    ],
    notes: [
        {
            heading: 'Cu roșii proaspete vs. conserve',
            bullets: [
                'Roșiile proaspete au mai multă apă — sosul are nevoie de 18–20 min să se reducă față de 10–12 cu conserve.',
                'Alege roșii foarte coapte (Roma, ciorchine sau San Marzano).',
            ],
        },
    ],
    attribution: 'Bunica',
}
{
    const r = parseRecipeArtifact(JSON.stringify(rich))
    check('schema: rich recipe parses', r.ok, r)
    if (r.ok) {
        check('schema: 6 ingredients preserved', r.value.ingredients.length === 6)
        check('schema: ingredient without amount stays unset', r.value.ingredients[5].amount === undefined && r.value.ingredients[5].unit === undefined)
        check('schema: scaleable=false preserved', r.value.ingredients[3].scaleable === false)
        check('schema: timer step kept', r.value.steps[1].timerSeconds === 150)
        check('schema: notes block intact', r.value.notes?.[0]?.bullets.length === 2)
        check('schema: image attribution required and present', r.value.images?.[0]?.attribution === 'retetefeldefel')
    }
}

// --- schema: invalid inputs ------------------------------------------------

{
    const r = parseRecipeArtifact('not json {')
    check('schema: invalid JSON has clear error', !r.ok && r.error.startsWith('Invalid JSON:'))
}

{
    const r = parseRecipeArtifact(JSON.stringify({ ...minimal, title: '' }))
    check('schema: empty title rejected at path', !r.ok && r.error.startsWith('title:'))
}

{
    const bad = { ...minimal, ingredients: [{ amount: 8, unit: 'oz', name: 'flour' }] }
    const r = parseRecipeArtifact(JSON.stringify(bad))
    check('schema: non-metric unit (oz) rejected', !r.ok && /ingredients\.0\.unit/.test(r.error))
}

{
    const bad = { ...minimal, ingredients: [{ amount: 2, unit: 'cup', name: 'milk' }] }
    const r = parseRecipeArtifact(JSON.stringify(bad))
    check('schema: US cup rejected', !r.ok && /ingredients\.0\.unit/.test(r.error))
}

{
    const bad = { ...minimal, ingredients: [{ amount: 400, name: 'flour' }] }
    const r = parseRecipeArtifact(JSON.stringify(bad))
    check('schema: amount without unit rejected by superRefine', !r.ok && /no unit/.test(r.error))
}

{
    const bad = { ...minimal, ingredients: [{ unit: 'g', name: 'flour' }] }
    const r = parseRecipeArtifact(JSON.stringify(bad))
    check('schema: unit without amount rejected by superRefine', !r.ok && /no amount/.test(r.error))
}

{
    const bad = { ...minimal, servings: { default: 5, min: 6 } }
    const r = parseRecipeArtifact(JSON.stringify(bad))
    check('schema: servings default < min rejected', !r.ok && /below min/.test(r.error))
}

{
    const bad = { ...minimal, servings: { default: 5, max: 4 } }
    const r = parseRecipeArtifact(JSON.stringify(bad))
    check('schema: servings default > max rejected', !r.ok && /above max/.test(r.error))
}

{
    const bad = { ...minimal, servings: { default: 5, min: 10, max: 4 } }
    const r = parseRecipeArtifact(JSON.stringify(bad))
    check('schema: servings min > max rejected', !r.ok && /greater than/.test(r.error))
}

{
    const bad = { ...minimal, ingredients: [] }
    const r = parseRecipeArtifact(JSON.stringify(bad))
    check('schema: empty ingredients rejected', !r.ok && /ingredients/.test(r.error))
}

{
    const bad = { ...minimal, steps: [] }
    const r = parseRecipeArtifact(JSON.stringify(bad))
    check('schema: empty steps rejected', !r.ok && /steps/.test(r.error))
}

{
    const bad = { ...minimal, images: [{ url: 'not-a-url', attribution: 'x' }] }
    const r = parseRecipeArtifact(JSON.stringify(bad))
    check('schema: non-URL image rejected', !r.ok && /images\.0\.url/.test(r.error))
}

{
    const bad = { ...minimal, images: [{ url: 'https://example.com/x.jpg' }] }
    const r = parseRecipeArtifact(JSON.stringify(bad))
    check('schema: image without attribution rejected', !r.ok && /images\.0\.attribution/.test(r.error))
}

// --- scale: scaleAmount ----------------------------------------------------

check('scale: 400 × 2 → 800', scaleAmount(400, 2) === 800)
check('scale: 400 × 0.5 → 200', scaleAmount(400, 0.5) === 200)
check('scale: 47 × 1 → 47 (mid range, nearest 0.5)', scaleAmount(47, 1) === 47)
check('scale: 47.3 × 1 → 47.5 (rounds up to nearest 0.5)', scaleAmount(47.3, 1) === 47.5)
check('scale: 47.2 × 1 → 47 (rounds down to nearest 0.5)', scaleAmount(47.2, 1) === 47)
check('scale: 2.55 × 1 → 2.6 (small range, 1 decimal)', scaleAmount(2.55, 1) === 2.6)
check('scale: 0.234 × 1 → 0.23 (sub-unit, 2 decimals)', scaleAmount(0.234, 1) === 0.23)
check('scale: 100 × 1.5 → 150 (large)', scaleAmount(100, 1.5) === 150)
check('scale: degenerate ratio 0 returns input', scaleAmount(400, 0) === 400)
check('scale: negative ratio returns input', scaleAmount(400, -1) === 400)
check('scale: NaN amount returns NaN', Number.isNaN(scaleAmount(Number.NaN, 2)))

// --- scale: scaledIngredientAmount ----------------------------------------

const noAmount: RecipeIngredient = { name: 'sare după gust', scaleable: true }
check('scale: ingredient without amount → null', scaledIngredientAmount(noAmount, 2) === null)

const nonScaleable: RecipeIngredient = { amount: 1, unit: 'bucata', name: 'frunză dafin', scaleable: false }
check('scale: scaleable=false keeps original', scaledIngredientAmount(nonScaleable, 4) === 1)

const normal: RecipeIngredient = { amount: 400, unit: 'g', name: 'paste', scaleable: true }
check('scale: normal ingredient scales', scaledIngredientAmount(normal, 1.5) === 600)

// --- scale: formatAmount ---------------------------------------------------

check('format: whole number renders without decimal', formatAmount(100) === '100')
check('format: 47.5 renders as 47.5', formatAmount(47.5) === '47.5')
check('format: 0.25 renders as 0.25', formatAmount(0.25) === '0.25')
check('format: 0.3 renders as 0.3 not 0.30', formatAmount(0.3) === '0.3')
check('format: trims floating-point cruft 0.1+0.2', formatAmount(0.1 + 0.2) === '0.3')
check('format: NaN renders as empty string', formatAmount(Number.NaN) === '')

// --- summary ---------------------------------------------------------------

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
