/**
 * Smoke test for `recipeToMarkdown`.
 *
 * Verifies the Copy-button output reads as a faithful markdown rendering of
 * the on-screen card: title, meta, ingredients (with current servings
 * applied), numbered steps with optional timer hints, notes, attribution.
 *
 * Run: npx tsx scripts/smoke-recipe-markdown.ts
 */
import type { RecipeArtifact } from '@/lib/recipe/schema'
import { recipeToMarkdown } from '@/lib/recipe/to-markdown'

let failures = 0
function check(label: string, cond: unknown, detail?: unknown) {
    const ok = Boolean(cond)
    console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  (' + JSON.stringify(detail) + ')'}`)
    if (!ok) failures++
}

const recipe: RecipeArtifact = {
    title: "Penne all'Arrabbiata",
    subtitle: 'Pastă picantă cu roșii.',
    servings: { default: 4, unitLabel: 'porții' },
    totalMinutes: 45,
    difficulty: 'usor',
    ingredients: [
        { amount: 400, unit: 'g', name: 'penne rigate', scaleable: true },
        { amount: 800, unit: 'g', name: 'roșii', note: 'San Marzano', scaleable: true },
        { amount: 4, unit: 'catei', name: 'usturoi', scaleable: true },
        { amount: 2, unit: 'bucata', name: 'peperoncino', scaleable: false },
        { name: 'sare după gust', scaleable: true },
        { amount: 200, unit: 'ml', name: 'vin alb', scaleable: true, group: 'Pentru sos:' },
    ],
    steps: [
        { title: 'Sotează', body: 'Adaugă usturoiul.', timerSeconds: 150 },
        { body: 'Servește imediat.' },
    ],
    notes: [
        { heading: 'Variații', bullets: ['Adaugă măsline', 'Pune busuioc'] },
    ],
    attribution: 'Bunica',
}

// --- default servings -----------------------------------------------------

{
    const md = recipeToMarkdown(recipe)
    check('header: title is H1', md.startsWith("# Penne all'Arrabbiata"))
    check('header: subtitle in italic', md.includes('_Pastă picantă cu roșii._'))
    check('meta: shows default servings + time + difficulty', md.includes('4 porții · 45 min · Ușor'))
    check('ingredients: section heading present', md.includes('## Ingrediente'))
    check('ingredients: scaled amount with unit', md.includes('- 400 g penne rigate'))
    check('ingredients: note rendered as italic parenthetical', md.includes('roșii _(San Marzano)_'))
    check('ingredients: count unit preserved', md.includes('- 4 catei usturoi'))
    check('ingredients: scaleable=false still printed at base', md.includes('- 2 bucata peperoncino'))
    check('ingredients: no-amount item renders without quantity', md.includes('- sare după gust'))
    check('ingredients: group heading rendered before scoped items', md.includes('**Pentru sos:**\n- 200 ml vin alb'))
    check('steps: numbered list', md.includes('1. **Sotează.**'))
    check('steps: timer hint in italic parens', md.includes('_(cronometru: 2:30)_'))
    check('steps: untitled step still numbered', md.includes('2. Servește imediat.'))
    check('notes: section heading', md.includes('## Notițe'))
    check('notes: block heading bold', md.includes('**Variații**'))
    check('notes: bullets present', md.includes('- Adaugă măsline'))
    check('attribution: in italic at end', md.trim().endsWith('_Sursă: Bunica_'))
    check('ends with newline', md.endsWith('\n'))
}

// --- scaled servings ------------------------------------------------------

{
    const md = recipeToMarkdown(recipe, { servings: 8 })
    check('scale 8x: meta reflects new servings', md.includes('8 porții'))
    check('scale 8x: 400g → 800g', md.includes('- 800 g penne rigate'))
    check('scale 8x: 4 catei → 8 catei', md.includes('- 8 catei usturoi'))
    check('scale 8x: scaleable=false stays 2', md.includes('- 2 bucata peperoncino'))
    check('scale 8x: vin alb scaled', md.includes('- 400 ml vin alb'))
}

// --- half servings --------------------------------------------------------

{
    const md = recipeToMarkdown(recipe, { servings: 2 })
    check('scale 0.5x: 400g → 200g', md.includes('- 200 g penne rigate'))
    check('scale 0.5x: scaleable=false stays 2 bucata', md.includes('- 2 bucata peperoncino'))
}

// --- minimal recipe -------------------------------------------------------

{
    const minimal: RecipeArtifact = {
        title: 'Test minim',
        servings: { default: 1 },
        ingredients: [{ amount: 100, unit: 'g', name: 'făină', scaleable: true }],
        steps: [{ body: 'Doar atât.' }],
    }
    const md = recipeToMarkdown(minimal)
    check('minimal: parses to valid markdown structure', md.includes('# Test minim') && md.includes('## Ingrediente') && md.includes('## Pași'))
    check('minimal: omits notes/attribution sections when absent', !md.includes('## Notițe') && !md.includes('Sursă:'))
    check('minimal: meta only has servings (default label)', md.includes('1 porții'))
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
