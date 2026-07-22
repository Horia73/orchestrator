import type { ToolDef, ToolResult } from '@/lib/ai/agents/types'
import {
    readExerciseImage,
    writeExerciseImage,
    type ExerciseImageRecord,
} from '@/lib/workout/storage'
import { searchExerciseGifCandidates } from '@/lib/workout/exercise-gif-search'
import { searchWorkoutImages } from '@/lib/workout/image-search'

// ---------------------------------------------------------------------------
// Verified exercise demo-image tools.
//
// The renderer intentionally performs NO automatic fuzzy discovery because a
// blind match routinely shows the wrong movement. These tools put the decision
// with the model, ONCE per exercise: search for real
// candidates, confirm one matches the exact prescribed movement/machine, and
// persist it. From then on the route serves the saved image for that exercise
// id and never fuzzy-guesses again.
//
// Tool results are plain data, so the model must hand the chosen URL to a visual
// browser/image tool before saving it. Canonical name + equipment narrows the
// shortlist; pixel-level confirmation is the final gate.
// ---------------------------------------------------------------------------

export const GET_EXERCISE_IMAGE_TOOL_ID = 'GetExerciseImage'
export const SEARCH_EXERCISE_IMAGES_TOOL_ID = 'SearchExerciseImages'
export const SAVE_EXERCISE_IMAGE_TOOL_ID = 'SaveExerciseImage'

const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/

export const getExerciseImageTool: ToolDef = {
    id: GET_EXERCISE_IMAGE_TOOL_ID,
    name: GET_EXERCISE_IMAGE_TOOL_ID,
    description: [
        'Look up the verified demo image already saved for an exercise (by its kebab-case slug, e.g. "chest-press-machine").',
        'Call this FIRST for every exercise before searching — a verified image is saved once and reused forever, so most exercises already have one and need no further work.',
        'Returns `found: true` with the saved image URL when one exists (bake it into the artifact `exercises[].imageUrl` and move on), or `found: false` when the exercise has no verified image yet — that is your cue to SearchExerciseImages, visually inspect the best candidate, then SaveExerciseImage.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            exerciseId: {
                type: 'string',
                description: 'Kebab-case exercise slug. Must match the artifact `exercises[].id`.',
            },
        },
        required: ['exerciseId'],
    },
    tags: ['workout', 'workout-history'],
}

export const searchExerciseImagesTool: ToolDef = {
    id: SEARCH_EXERCISE_IMAGES_TOOL_ID,
    name: SEARCH_EXERCISE_IMAGES_TOOL_ID,
    description: [
        'Search for real demo-image/GIF candidates for an exercise so you can pick the ONE that actually depicts the prescribed movement/machine, then persist it with SaveExerciseImage.',
        'Returns two lists: `exerciseDbCandidates` (each carries the exact canonical exercise `name` — match it against the movement + equipment you are prescribing; this is your primary signal) and `webCandidates` (still images from a keyless web search, url + attribution only).',
        'Use canonical name/equipment to shortlist, then ALWAYS hand the chosen URL to browser_agent (or another visual image tool) and inspect the pixels before saving. If it is wrong, inspect another result or rephrase the query. Do NOT save an uninspected candidate.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            name: {
                type: 'string',
                description: 'Exercise display/search name, e.g. "cable lateral raise", "seated chest press machine". English names match best.',
            },
            exerciseId: {
                type: 'string',
                description: 'Optional kebab-case slug for context (also used to seed the query when name is absent).',
            },
            query: {
                type: 'string',
                description: 'Optional explicit search string to override the name-derived query.',
            },
            equipment: {
                type: 'string',
                description: 'Optional equipment hint (e.g. "cable", "machine", "dumbbell") to disambiguate candidates.',
            },
            limit: {
                type: 'number',
                description: 'Max candidates per list. Defaults to 6, cap 10.',
            },
        },
    },
    tags: ['workout', 'workout-history'],
}

export const saveExerciseImageTool: ToolDef = {
    id: SAVE_EXERCISE_IMAGE_TOOL_ID,
    name: SAVE_EXERCISE_IMAGE_TOOL_ID,
    description: [
        'Persist the verified demo image for an exercise so it is reused across every future session — save it ONCE per exercise/machine.',
        'Only call this after you visually inspected the URL and confirmed it depicts the exact prescribed movement/machine. The renderer serves this saved image and never substitutes a fuzzy fallback.',
        'Pass the exercise slug and direct image/GIF URL; include a short `note` describing the visual confirmation (e.g. "Inspected GIF: standing cable lateral raise, single handle").',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            exerciseId: {
                type: 'string',
                description: 'Kebab-case exercise slug. Must match the artifact `exercises[].id`.',
            },
            url: {
                type: 'string',
                description: 'Direct https image/GIF URL for the exact movement/setup.',
            },
            name: {
                type: 'string',
                description: 'Optional exercise display name at save time.',
            },
            source: {
                type: 'string',
                description: 'Optional source label (e.g. "ExerciseDB OSS", the site domain).',
            },
            note: {
                type: 'string',
                description: 'Required short audit note stating what you visually confirmed in the image/GIF.',
            },
        },
        required: ['exerciseId', 'url', 'note'],
    },
    tags: ['workout', 'workout-history'],
}

// === execution =============================================================

function normalizeSlug(value: unknown): string {
    return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export async function executeGetExerciseImage(args: Record<string, unknown>): Promise<ToolResult> {
    const exerciseId = normalizeSlug(args.exerciseId)
    if (!SLUG_RE.test(exerciseId)) {
        return { success: false, error: 'exerciseId must be a kebab-case slug like "chest-press-machine"' }
    }
    const record = readExerciseImage(exerciseId)
    if (!record) {
        return {
            success: true,
            data: {
                exerciseId,
                found: false,
                message: 'No verified image saved yet. Call SearchExerciseImages, visually inspect the best candidate, then SaveExerciseImage so it is reused forever.',
            },
        }
    }
    return {
        success: true,
        data: {
            exerciseId,
            found: true,
            url: record.url,
            name: record.name,
            source: record.source,
            note: record.note,
            verifiedAt: record.verifiedAt,
            hint: 'Bake this into the artifact `exercises[].imageUrl`. The renderer also serves it automatically by exercise id.',
        },
    }
}

export async function executeSearchExerciseImages(args: Record<string, unknown>): Promise<ToolResult> {
    const name = typeof args.name === 'string' ? args.name.trim() : ''
    const slug = normalizeSlug(args.exerciseId)
    const equipment = typeof args.equipment === 'string' ? args.equipment.trim() : ''
    const explicit = typeof args.query === 'string' ? args.query.trim() : ''
    const limitRaw = typeof args.limit === 'number' ? args.limit : 6
    const limit = Math.max(1, Math.min(10, Math.floor(limitRaw)))

    const base = explicit || [name, slug ? slug.replace(/[-_]+/g, ' ') : ''].find((v) => v && v.length) || ''
    const query = [base, equipment].filter((v) => v && v.length).join(' ').trim()
    if (!query) {
        return { success: false, error: 'Provide a name, exerciseId, or query to search for.' }
    }

    try {
        const [exerciseDbCandidates, webResults] = await Promise.all([
            searchExerciseGifCandidates(query, { limit }),
            searchWorkoutImages(query, { limit }),
        ])
        // Web fallback: drop any that duplicate an ExerciseDB GIF we already list.
        const gifUrls = new Set(exerciseDbCandidates.map((c) => c.url))
        const webCandidates = webResults
            .filter((r) => !gifUrls.has(r.url))
            .slice(0, limit)
            .map((r) => ({ url: r.url, attribution: r.attribution, mime: r.mime }))
        return {
            success: true,
            data: {
                query,
                exerciseDbCandidates,
                webCandidates,
                hint: 'Shortlist by name/equipment, visually inspect the chosen URL, then call SaveExerciseImage. If it is wrong, inspect another candidate or rephrase the query; leaving it blank is better than saving the wrong demo.',
            },
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        return { success: false, error: `Image search failed: ${message}` }
    }
}

export async function executeSaveExerciseImage(args: Record<string, unknown>): Promise<ToolResult> {
    const exerciseId = normalizeSlug(args.exerciseId)
    if (!SLUG_RE.test(exerciseId)) {
        return { success: false, error: 'exerciseId must be a kebab-case slug like "chest-press-machine"' }
    }
    const url = typeof args.url === 'string' ? args.url.trim() : ''
    if (!isSaveableImageUrl(url)) {
        return { success: false, error: 'url must be a direct https image/GIF URL (or an /api/uploads path).' }
    }
    const note = typeof args.note === 'string' ? args.note.trim().slice(0, 300) : ''
    if (!note) {
        return { success: false, error: 'note is required: state what you visually confirmed before saving this image.' }
    }
    const record: ExerciseImageRecord = {
        id: exerciseId,
        url,
        name: typeof args.name === 'string' ? args.name.trim().slice(0, 120) || undefined : undefined,
        source: typeof args.source === 'string' ? args.source.trim().slice(0, 120) || undefined : undefined,
        note,
        verifiedAt: new Date().toISOString(),
    }
    try {
        writeExerciseImage(record)
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error'
        return { success: false, error: `Could not save image: ${message}` }
    }
    return {
        success: true,
        data: {
            saved: true,
            exerciseId,
            url,
            message: 'Saved. This verified image now shows for this exercise in every future session; the renderer will not replace it with a fuzzy fallback. Bake it into the current artifact `exercises[].imageUrl` too.',
        },
    }
}

function isSaveableImageUrl(url: string): boolean {
    if (!url || url.length > 2048) return false
    if (url.startsWith('/api/uploads/') || url.startsWith('/files/')) return true
    try {
        const parsed = new URL(url)
        return parsed.protocol === 'https:'
    } catch {
        return false
    }
}
