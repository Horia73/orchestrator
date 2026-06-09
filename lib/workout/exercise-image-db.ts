import rawDb from './exercise-image-db.json'
import type { WorkoutImageResult } from './image-search'

// ---------------------------------------------------------------------------
// Built-in exercise demo-image library.
//
// Backed by the Free Exercise DB (yuhonas/free-exercise-db, public domain),
// bundled as a compact index (`exercise-image-db.json`) and served from the
// jsDelivr CDN pinned to a commit SHA. This replaces the old keyless Wikimedia
// Commons search as the PRIMARY source: Commons has poor, inconsistent coverage
// for specific gym movements, so most lookups returned junk or nothing.
//
// Resolution is local and deterministic — we match the prescribed exercise
// (by its English-canonical `id` plus display `name`, with muscle/equipment as
// tie-breakers) against the index and return a stable image URL. There is no
// network call to resolve the match (only the image itself loads in the
// browser, lazily, with a graceful onError fallback in the renderer), so we
// never "re-fetch" the same exercise.
//
// The route falls back to the Commons keyless search only when this library
// has no confident match.
// ---------------------------------------------------------------------------

interface RawEntry {
    name: string
    image: string
    muscles: string[]
    equipment: string | null
}

interface RawDb {
    _meta: { source: string; license: string; sha: string; cdnBase: string }
    exercises: RawEntry[]
}

const db = rawDb as unknown as RawDb

interface IndexedEntry {
    entry: RawEntry
    tokens: Set<string>
    tokenCount: number
}

// Generic gym/filler words that carry no matching signal. Includes a few
// Romanian fillers/equipment words because workout display names can be mixed
// language ("Lateral raise la cablu", "Aparat deltoid lateral").
const STOPWORDS = new Set([
    'exercise', 'exercises', 'gym', 'machine', 'workout', 'fitness', 'strength',
    'demo', 'form', 'setup', 'variation', 'variations', 'move', 'movement',
    'the', 'a', 'an', 'with', 'and', 'or', 'for', 'to', 'of', 'on', 'in', 'your', 'position',
    'la', 'cu', 'pe', 'de', 'si', 'din', 'un', 'o', 'pentru', 'aparat',
])

// Abbreviation / spelling normalization → canonical tokens.
const SYNONYMS: Record<string, string[]> = {
    ohp: ['overhead', 'press'],
    db: ['dumbbell'],
    dumbell: ['dumbbell'],
    bb: ['barbell'],
    rdl: ['romanian', 'deadlift'],
    bw: ['bodyweight'],
    pullup: ['pull', 'up'],
    pullups: ['pull', 'up'],
    chinup: ['chin', 'up'],
    chinups: ['chin', 'up'],
    pushup: ['push', 'up'],
    pushups: ['push', 'up'],
    situp: ['sit', 'up'],
    situps: ['sit', 'up'],
}

function normalizeTokens(input: string): string[] {
    const base = input
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
    if (!base) return []
    const out: string[] = []
    for (const tok of base.split(/\s+/)) {
        if (!tok) continue
        const synonym = SYNONYMS[tok]
        if (synonym) { out.push(...synonym); continue }
        if (STOPWORDS.has(tok)) continue
        out.push(tok)
    }
    return out
}

let INDEX: IndexedEntry[] | null = null
function getIndex(): IndexedEntry[] {
    if (INDEX) return INDEX
    INDEX = db.exercises.map((entry) => {
        const tokens = new Set(normalizeTokens(entry.name))
        return { entry, tokens, tokenCount: tokens.size }
    })
    return INDEX
}

// Our MuscleGroup slugs → Free Exercise DB primaryMuscles terms (for scoring).
const MUSCLE_MAP: Record<string, string[]> = {
    chest: ['chest'],
    front_delt: ['shoulders'], side_delt: ['shoulders'], rear_delt: ['shoulders'],
    triceps: ['triceps'], biceps: ['biceps'], forearms: ['forearms'],
    lats: ['lats'], mid_back: ['middle back'], rhomboids: ['middle back'], traps: ['traps'],
    quads: ['quadriceps'], hamstrings: ['hamstrings'], glutes: ['glutes'], calves: ['calves'],
    adductors: ['adductors'], abductors: ['abductors'],
    abs: ['abdominals'], obliques: ['abdominals'], lower_back: ['lower back'],
    full_body: [], cardio: [],
}

// Our WorkoutEquipment slugs → Free Exercise DB equipment terms (for scoring).
const EQUIP_MAP: Record<string, string> = {
    barbell: 'barbell', dumbbell: 'dumbbell', kettlebell: 'kettlebells', machine: 'machine',
    cable: 'cable', bodyweight: 'body only', band: 'bands', plates: 'barbell',
}

export interface ResolveExerciseImageInput {
    /** English-canonical kebab-case id ("bench-press") — the strongest signal. */
    id?: string
    /** Display name (may be localized). */
    name?: string
    /** MuscleGroup slugs — used as a tie-breaker. */
    muscles?: readonly string[]
    /** WorkoutEquipment slugs — used as a tie-breaker. */
    equipment?: readonly string[]
}

/**
 * Resolve a demo image for an exercise from the built-in library. Returns null
 * when there is no confident match (caller should fall back to web search).
 *
 * Matching: token overlap between the query (id + name) and each entry's name.
 * We require either ≥2 shared tokens, or a single-token exact hit (for moves
 * like "plank" / "squat"), then rank by coverage + precision with muscle and
 * equipment bonuses. Picking the max means a precise match always beats a
 * loose partial, so a few incidental shared words ("press") never win over the
 * right exercise when it exists.
 */
export function resolveExerciseImage(input: ResolveExerciseImageInput): WorkoutImageResult | null {
    const queryTokens = new Set<string>([
        ...normalizeTokens((input.id ?? '').replace(/[-_]+/g, ' ')),
        ...normalizeTokens(input.name ?? ''),
    ])
    if (queryTokens.size === 0) return null

    const wantMuscles = new Set<string>()
    for (const m of input.muscles ?? []) {
        for (const fed of MUSCLE_MAP[m] ?? []) wantMuscles.add(fed)
    }
    const wantEquip = new Set<string>()
    for (const e of input.equipment ?? []) {
        const fed = EQUIP_MAP[e]
        if (fed) wantEquip.add(fed)
    }

    let best: { score: number; entry: RawEntry } | null = null
    for (const idx of getIndex()) {
        let shared = 0
        for (const t of queryTokens) {
            if (idx.tokens.has(t)) shared++
        }
        const accept = shared >= 2 || (queryTokens.size === 1 && shared === 1)
        if (!accept) continue

        const coverage = shared / queryTokens.size          // how much of the query matched
        const precision = shared / Math.max(1, idx.tokenCount) // how specific the entry is
        let score = coverage * 100 + precision * 20
        if (wantMuscles.size && idx.entry.muscles.some((m) => wantMuscles.has(m))) score += 15
        if (wantEquip.size && idx.entry.equipment && wantEquip.has(idx.entry.equipment)) score += 12

        if (!best || score > best.score) best = { score, entry: idx.entry }
    }

    if (!best) return null
    const e = best.entry
    return {
        url: db._meta.cdnBase + e.image,
        sourceUrl: `https://github.com/${db._meta.source}/blob/${db._meta.sha}/exercises/${e.image}`,
        attribution: 'Free Exercise DB',
        // Free Exercise DB photos are roughly 4:3; the renderer uses this only
        // to reserve aspect ratio and avoid layout shift while loading.
        width: 4,
        height: 3,
        mime: 'image/jpeg',
    }
}
