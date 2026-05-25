/**
 * Smoke test for `interpolateScalableQuantities`.
 *
 * Verifies the {{N unit}} token in step bodies / notes scales correctly with
 * ratio, leaves un-tokenized text untouched (times, qualitative measures,
 * oven temps), and survives malformed input without damaging surrounding
 * prose.
 *
 * Run: npx tsx scripts/smoke-recipe-interpolate.ts
 */
import { interpolateScalableQuantities } from '@/lib/recipe/interpolate'

let failures = 0
function check(label: string, cond: unknown, detail?: unknown) {
    const ok = Boolean(cond)
    console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  (' + JSON.stringify(detail) + ')'}`)
    if (!ok) failures++
}

// --- single-value tokens --------------------------------------------------

check('single: scales by 2', interpolateScalableQuantities('Păstrează {{120 ml}} apă', 2) === 'Păstrează 240 ml apă')
check('single: scales by 0.5', interpolateScalableQuantities('{{400 g}} făină', 0.5) === '200 g făină')
check('single: ratio=1 keeps value, drops braces', interpolateScalableQuantities('{{400 g}} făină', 1) === '400 g făină')
check('single: fractional input', interpolateScalableQuantities('{{0.5 catel}} usturoi', 4) === '2 catel usturoi')
check('single: comma decimal accepted', interpolateScalableQuantities('{{1,5 l}} apă', 2) === '3 l apă')
check('single: multi-word unit kept', interpolateScalableQuantities('{{2 linguri rase}} zahăr', 2) === '4 linguri rase zahăr')

// --- range tokens ---------------------------------------------------------

check('range: hyphen ascii', interpolateScalableQuantities('{{2-3 linguri}} zahăr', 2) === '4–6 linguri zahăr')
check('range: en dash', interpolateScalableQuantities('{{2–3 linguri}} zahăr', 2) === '4–6 linguri zahăr')
check('range: ratio=0.5', interpolateScalableQuantities('{{2-3 linguri}} zahăr', 0.5) === '1–1.5 linguri zahăr')

// --- mixed and multiple tokens in one string ------------------------------

const multi = 'Pune {{200 g}} paste în apă cu {{20 g}} sare; rezervă {{120 ml}} apă.'
const expected = 'Pune 400 g paste în apă cu 40 g sare; rezervă 240 ml apă.'
check('multi: all tokens scaled in one pass', interpolateScalableQuantities(multi, 2) === expected)

// --- leave-as-is cases ----------------------------------------------------

check('plain: numeric without braces untouched', interpolateScalableQuantities('Fierbe 1 minut.', 4) === 'Fierbe 1 minut.')
check('plain: range without braces untouched', interpolateScalableQuantities('Așteaptă 2-3 minute.', 4) === 'Așteaptă 2-3 minute.')
check('plain: oven temp untouched', interpolateScalableQuantities('Coace la 180°C.', 4) === 'Coace la 180°C.')
check('plain: qualitative untouched', interpolateScalableQuantities('O priza de sare.', 4) === 'O priza de sare.')
check('plain: no braces at all → no-op', interpolateScalableQuantities('Servește imediat.', 4) === 'Servește imediat.')

// --- malformed tokens (leave verbatim) ------------------------------------

check('malformed: empty braces', interpolateScalableQuantities('{{}} ok', 2) === '{{}} ok')
check('malformed: just text inside', interpolateScalableQuantities('{{ceva}} text', 2) === '{{ceva}} text')
check('malformed: missing unit', interpolateScalableQuantities('{{120}} apă', 2) === '{{120}} apă')
check('malformed: unparseable preserved, prose intact', interpolateScalableQuantities('Adaugă {{aroma}} la sfârșit.', 2) === 'Adaugă {{aroma}} la sfârșit.')

// --- regression: brace pairs across newlines should NOT match -------------

const acrossLines = 'first {{\n200 g}} bad'
check('safety: tokens do not span newlines', interpolateScalableQuantities(acrossLines, 2) === acrossLines)

// --- edge cases on scaling --------------------------------------------------

check('large input: rounds to whole number', interpolateScalableQuantities('{{800 g}} roșii', 3) === '2400 g roșii')
check('small input: keeps 2 decimals', interpolateScalableQuantities('{{0.1 g}} sare', 2) === '0.2 g sare')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
