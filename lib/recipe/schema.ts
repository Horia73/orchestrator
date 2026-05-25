import { z } from 'zod'

// ---------------------------------------------------------------------------
// Recipe artifact domain schema.
//
// A `RecipeArtifact` is the JSON payload the orchestrator emits inside an
// `<artifact type="application/vnd.ant.recipe">` block. The renderer parses
// this with Zod and hands the validated shape to a native React UI (header,
// servings stepper, scalable ingredient list, numbered steps with live timer
// chips, notes card, web-image carousel).
//
// Design choices that lock the shape in early so it can be versioned cleanly:
//   - Units are restricted to an EU-metric allowlist. We never want to render
//     an "oz" or "cup" because we don't want to build (or expose) a converter.
//     The model is instructed in its prompt to emit metric only; if it slips,
//     the parser refuses the artifact rather than silently misrendering.
//   - `amount` is optional on ingredients because real recipes contain
//     "sare după gust" or "ulei pentru prăjit" with no number. Such
//     ingredients render but never scale.
//   - `scaleable` defaults to `true`. Set to `false` for ingredients where
//     linear scaling lies (a single basil leaf, one bay leaf, one egg in a
//     dough — doubling the recipe doesn't mean two basil leaves).
//   - `timerSeconds` on a step renders a live countdown chip. Bounded at 24h
//     to defend the UI from runaway values.
//   - `imageQuery` is the search string Step 5 hands to the image API. It's
//     separated from `images[]` so the model can request fresh images each
//     turn without baking a stale URL into the artifact body.
//   - `notes[]` is a free-form "tips & variations" section, grouped into
//     bulleted blocks with optional headings (mirrors what the user shared in
//     the claude.ai screenshot).
//
// This module imports nothing but zod — it sits at the bottom of the import
// graph so both the server-side validator and the client-side renderer can
// depend on it without cycles.
// ---------------------------------------------------------------------------

// --- units -----------------------------------------------------------------

/**
 * EU-metric unit allowlist. Includes count/portion units common in Romanian
 * cooking ("căței" for garlic cloves, "felii" for slices, "vârf" for a knife
 * tip of an ingredient). Excluded by design: oz, lb, cup (US volume), pint,
 * quart, gallon, fl-oz.
 *
 * If the model emits a unit outside this list, the parser rejects the entire
 * artifact — we'd rather show an actionable error than render a broken card.
 */
export const RecipeUnitSchema = z.enum([
    // Mass
    'g', 'kg',
    // Volume
    'ml', 'cl', 'l',
    // Spoon measures (international, language-neutral abbreviations)
    'tsp', 'tbsp',
    // Count / portion units (Romanian-friendly; the renderer can format any
    // of these into a localized label without losing meaning)
    'bucata', 'buc',
    'catel', 'catei',
    'felie', 'felii',
    'priza',
    'varf',
    'cana',
    'capac',
])
export type RecipeUnit = z.infer<typeof RecipeUnitSchema>

// --- ingredient ------------------------------------------------------------

export const RecipeIngredientSchema = z.object({
    /** Optional because "sare după gust" / "ulei pentru prăjit" exist. */
    amount: z.number().positive().max(100_000).optional(),
    /** Required when `amount` is present, omitted for count-less ingredients. */
    unit: RecipeUnitSchema.optional(),
    /** What the thing is: "penne rigate", "usturoi". */
    name: z.string().min(1).max(120),
    /** Free-form qualifier rendered as a muted aside: "pentru apa de pastă". */
    note: z.string().min(1).max(200).optional(),
    /**
     * Set to `false` for ingredients where linear scaling would lie
     * (single basil leaf, one bay leaf, one egg in dough). Default true.
     */
    scaleable: z.boolean().default(true),
    /**
     * Optional grouping header, e.g. "Pentru sos:" / "Pentru garnitură:".
     * The renderer groups consecutive ingredients sharing a `group` under
     * that heading. Ingredients without a group render in the default list.
     */
    group: z.string().min(1).max(60).optional(),
})
export type RecipeIngredient = z.infer<typeof RecipeIngredientSchema>

// --- step ------------------------------------------------------------------

export const RecipeStepSchema = z.object({
    /** Short bolded action header, e.g. "Sotează usturoiul". Optional. */
    title: z.string().min(1).max(120).optional(),
    /** Body of the step. Plain text or simple markdown (no code blocks). */
    body: z.string().min(1).max(2000),
    /** When present, renders an interactive live timer chip inline with body. */
    timerSeconds: z.number().int().min(1).max(86_400).optional(),
})
export type RecipeStep = z.infer<typeof RecipeStepSchema>

// --- notes -----------------------------------------------------------------

export const RecipeNoteBlockSchema = z.object({
    heading: z.string().min(1).max(120).optional(),
    bullets: z.array(z.string().min(1).max(400)).min(1).max(20),
})
export type RecipeNoteBlock = z.infer<typeof RecipeNoteBlockSchema>

// --- image -----------------------------------------------------------------

export const RecipeImageSchema = z.object({
    url: z.string().url().max(2048),
    /** Domain or photographer to credit. Required — no anonymous hotlinking. */
    attribution: z.string().min(1).max(120),
    /** Click-through to the source page when present. */
    sourceUrl: z.string().url().max(2048).optional(),
    alt: z.string().min(1).max(200).optional(),
})
export type RecipeImage = z.infer<typeof RecipeImageSchema>

// --- servings --------------------------------------------------------------

export const RecipeServingsSchema = z.object({
    /** Default and starting value for the stepper. */
    default: z.number().int().min(1).max(100),
    min: z.number().int().min(1).max(100).optional(),
    max: z.number().int().min(1).max(100).optional(),
    /**
     * Display label for the unit of serving — defaults to "porții" in the
     * renderer when omitted. Lets a cocktail recipe say "pahare" or a bread
     * recipe say "felii".
     */
    unitLabel: z.string().min(1).max(30).optional(),
})
export type RecipeServings = z.infer<typeof RecipeServingsSchema>

// --- top-level -------------------------------------------------------------

export const RecipeArtifactSchema = z.object({
    title: z.string().min(1).max(160),
    subtitle: z.string().min(1).max(280).optional(),
    servings: RecipeServingsSchema,
    /** Minutes of active prep before cooking starts. */
    prepMinutes: z.number().int().min(0).max(10_000).optional(),
    /** Minutes the food is actually being cooked. */
    cookMinutes: z.number().int().min(0).max(10_000).optional(),
    /**
     * Total elapsed time including rests, marinades, etc. If omitted, the
     * renderer falls back to prep + cook.
     */
    totalMinutes: z.number().int().min(0).max(10_000).optional(),
    difficulty: z.enum(['usor', 'mediu', 'greu']).optional(),
    /** Search string for Step 5's image fetcher. */
    imageQuery: z.string().min(1).max(200).optional(),
    /** Pre-resolved images. Step 5 also populates this from a server fetch. */
    images: z.array(RecipeImageSchema).max(8).optional(),
    ingredients: z.array(RecipeIngredientSchema).min(1).max(60),
    steps: z.array(RecipeStepSchema).min(1).max(40),
    notes: z.array(RecipeNoteBlockSchema).max(8).optional(),
    /** Attribution for the recipe itself (cookbook, site, chef). */
    attribution: z.string().min(1).max(200).optional(),
})
    .superRefine((recipe, ctx) => {
        // Cross-field invariant: an ingredient with `amount` must declare a
        // `unit`, and vice versa. We don't want "400 penne" (no unit) or
        // "g penne" (no amount) leaking into the renderer.
        recipe.ingredients.forEach((ing, idx) => {
            const hasAmount = ing.amount !== undefined
            const hasUnit = ing.unit !== undefined
            if (hasAmount !== hasUnit) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['ingredients', idx],
                    message: hasAmount
                        ? `ingredient "${ing.name}" has amount=${ing.amount} but no unit; pick one from the metric allowlist or drop the amount`
                        : `ingredient "${ing.name}" has unit="${ing.unit}" but no amount; add a number or drop the unit`,
                })
            }
        })
        // servings.min/max sanity. Check structural ordering first (min>max
        // makes ANY default invalid, so the more useful error is the bad
        // range itself rather than the downstream default<min violation).
        const { default: def, min, max } = recipe.servings
        if (min !== undefined && max !== undefined && min > max) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['servings'],
                message: `servings.min (${min}) is greater than servings.max (${max})`,
            })
        } else {
            if (min !== undefined && def < min) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['servings'],
                    message: `default servings (${def}) is below min (${min})`,
                })
            }
            if (max !== undefined && def > max) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['servings'],
                    message: `default servings (${def}) is above max (${max})`,
                })
            }
        }
    })
export type RecipeArtifact = z.infer<typeof RecipeArtifactSchema>
