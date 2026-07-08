import type { WorkoutImageResult } from './image-search'

const SEARCH_ENDPOINT = 'https://oss.exercisedb.dev/api/v1/exercises/search'
const DETAIL_ENDPOINT = 'https://oss.exercisedb.dev/api/v1/exercises'

const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const CACHE_MAX_ENTRIES = 300
const MIN_RESOLVE_SCORE = 55

interface ExerciseDbGifEntry {
    exerciseId: string
    name: string
    gifUrl: string
}

interface ExerciseDbSearchResponse {
    success?: boolean
    data?: unknown
}

interface CacheEntry {
    expiresAt: number
    value: ExerciseDbGifEntry[]
}

const CACHE = new Map<string, CacheEntry>()

export interface ResolveExerciseGifInput {
    id?: string
    name?: string
    muscles?: readonly string[]
    equipment?: readonly string[]
}

const STOPWORDS = new Set([
    'exercise', 'exercises', 'gym', 'machine', 'workout', 'fitness', 'strength',
    'demo', 'form', 'setup', 'variation', 'variations', 'move', 'movement',
    'the', 'a', 'an', 'with', 'and', 'or', 'for', 'to', 'of', 'on', 'in', 'your', 'position',
    'la', 'cu', 'pe', 'de', 'si', 'din', 'un', 'o', 'pentru', 'aparat',
])

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
    tricep: ['triceps'],
    bicep: ['biceps'],
    lat: ['lats'],
    delt: ['deltoid'],
}

const EQUIPMENT_QUERY: Record<string, string | null> = {
    barbell: 'barbell',
    dumbbell: 'dumbbell',
    kettlebell: 'kettlebell',
    machine: null,
    cable: 'cable',
    bodyweight: 'body weight',
    band: 'band',
    plates: 'plate',
    bench: null,
    rack: null,
    pullup_bar: 'pull up bar',
    box: 'box',
    rower: 'rower',
    bike: 'bike',
    treadmill: 'treadmill',
    sled: 'sled',
    rings: 'rings',
    trx: 'suspension',
    mat: null,
    foam_roller: 'foam roller',
    jump_rope: 'jump rope',
    other: null,
}

export async function resolveExerciseGif(
    input: ResolveExerciseGifInput,
    options: { signal?: AbortSignal } = {},
): Promise<WorkoutImageResult | null> {
    const candidates = buildSearchCandidates(input)
    if (candidates.length === 0) return null

    for (const candidate of candidates) {
        const entries = await searchExerciseDbGifEntries(candidate, { signal: options.signal })
        const best = pickBestEntry(entries, candidate)
        if (best && best.score >= MIN_RESOLVE_SCORE) return toWorkoutImage(best.entry)
    }

    return null
}

export async function searchExerciseGifs(
    rawQuery: string,
    options: { limit?: number; signal?: AbortSignal } = {},
): Promise<WorkoutImageResult[]> {
    const limit = Math.min(8, Math.max(1, Math.floor(options.limit ?? 4)))
    const entries = await searchExerciseDbGifEntries(rawQuery, { signal: options.signal })
    return entries.slice(0, limit).map(toWorkoutImage)
}

export interface ExerciseGifCandidate {
    /** The exact canonical exercise name from ExerciseDB — the strongest
     *  signal the model has to confirm a candidate matches the prescribed move
     *  (it cannot see the pixels through a tool result). */
    name: string
    url: string
    exerciseId: string
}

/** Like `searchExerciseGifs` but keeps each result's canonical name so the
 *  model can deliberately match a candidate to the exercise it is prescribing.
 *  Used by the SearchExerciseImages tool. */
export async function searchExerciseGifCandidates(
    rawQuery: string,
    options: { limit?: number; signal?: AbortSignal } = {},
): Promise<ExerciseGifCandidate[]> {
    const limit = Math.min(10, Math.max(1, Math.floor(options.limit ?? 6)))
    const entries = await searchExerciseDbGifEntries(rawQuery, { signal: options.signal })
    return entries.slice(0, limit).map((e) => ({ name: e.name, url: e.gifUrl, exerciseId: e.exerciseId }))
}

export function parseExerciseDbGifEntries(json: ExerciseDbSearchResponse): ExerciseDbGifEntry[] {
    if (!json.success || !Array.isArray(json.data)) return []
    const out: ExerciseDbGifEntry[] = []
    for (const item of json.data) {
        if (!item || typeof item !== 'object') continue
        const record = item as Record<string, unknown>
        const exerciseId = typeof record.exerciseId === 'string' ? record.exerciseId.trim() : ''
        const name = typeof record.name === 'string' ? record.name.trim() : ''
        const gifUrl = typeof record.gifUrl === 'string' ? record.gifUrl.trim() : ''
        if (!exerciseId || !name || !isExerciseDbGifUrl(gifUrl)) continue
        out.push({ exerciseId, name, gifUrl })
    }
    return out
}

function buildSearchCandidates(input: ResolveExerciseGifInput): string[] {
    const equipment = firstEquipmentQuery(input.equipment)
    const bases = uniqueCompact([
        input.name,
        input.id ? input.id.replace(/[-_]+/g, ' ') : '',
    ])
        .map((value) => value.trim())
        .filter((value) => normalizeTokens(value).length > 0)

    const candidates: string[] = []
    for (const base of bases) {
        candidates.push(equipment ? `${equipment} ${base}` : base)
        candidates.push(base)
    }
    return uniqueCompact(candidates).map((value) => value.slice(0, 120))
}

function firstEquipmentQuery(equipment: readonly string[] | undefined): string | null {
    for (const item of equipment ?? []) {
        const query = EQUIPMENT_QUERY[item]
        if (query) return query
    }
    return null
}

async function searchExerciseDbGifEntries(
    rawQuery: string,
    options: { signal?: AbortSignal } = {},
): Promise<ExerciseDbGifEntry[]> {
    const query = rawQuery.trim()
    if (!query) return []
    const cacheKey = query.toLowerCase()

    const cached = CACHE.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
        CACHE.delete(cacheKey)
        CACHE.set(cacheKey, cached)
        return cached.value
    }

    try {
        const url = new URL(SEARCH_ENDPOINT)
        url.searchParams.set('search', query)
        const response = await fetch(url.toString(), {
            headers: {
                Accept: 'application/json',
                'User-Agent': 'orchestrator-workout/1.0 (+https://github.com/horia/orchestrator)',
            },
            signal: options.signal,
        })
        if (!response.ok) return []
        const entries = parseExerciseDbGifEntries((await response.json()) as ExerciseDbSearchResponse)
        writeCache(cacheKey, entries)
        return entries
    } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') throw err
        return []
    }
}

function pickBestEntry(
    entries: readonly ExerciseDbGifEntry[],
    candidate: string,
): { entry: ExerciseDbGifEntry; score: number } | null {
    let best: { entry: ExerciseDbGifEntry; score: number } | null = null
    for (const entry of entries) {
        const score = scoreEntry(entry, candidate)
        if (!best || score > best.score) best = { entry, score }
    }
    return best
}

function scoreEntry(entry: ExerciseDbGifEntry, candidate: string): number {
    const queryTokens = new Set(normalizeTokens(candidate))
    const entryTokens = new Set(normalizeTokens(entry.name))
    if (queryTokens.size === 0 || entryTokens.size === 0) return 0

    let shared = 0
    for (const token of queryTokens) {
        if (entryTokens.has(token)) shared++
    }
    if (shared === 0) return 0

    const coverage = shared / queryTokens.size
    const precision = shared / entryTokens.size
    let score = coverage * 100 + precision * 30

    const compactEntry = compact(entry.name)
    const compactCandidate = compact(candidate)
    if (compactEntry === compactCandidate) score += 40
    else if (compactEntry.startsWith(compactCandidate)) score += 18

    if (shared < Math.min(2, queryTokens.size)) score -= 40
    return score
}

function normalizeTokens(input: string): string[] {
    const base = input
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
    if (!base) return []

    const out: string[] = []
    for (const raw of base.split(/\s+/)) {
        if (!raw || STOPWORDS.has(raw)) continue
        const synonym = SYNONYMS[raw]
        if (synonym) {
            out.push(...synonym)
            continue
        }
        out.push(stemToken(raw))
    }
    return out
}

function stemToken(token: string): string {
    if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`
    if (
        token.endsWith('s')
        && token.length > 4
        && !token.endsWith('ss')
        && token !== 'triceps'
        && token !== 'biceps'
        && token !== 'lats'
        && token !== 'abs'
    ) {
        return token.slice(0, -1)
    }
    return token
}

function compact(input: string): string {
    return normalizeTokens(input).join(' ')
}

function isExerciseDbGifUrl(url: string): boolean {
    try {
        const parsed = new URL(url)
        return parsed.protocol === 'https:' && parsed.hostname === 'static.exercisedb.dev' && parsed.pathname.endsWith('.gif')
    } catch {
        return false
    }
}

function toWorkoutImage(entry: ExerciseDbGifEntry): WorkoutImageResult {
    return {
        url: entry.gifUrl,
        sourceUrl: `${DETAIL_ENDPOINT}/${encodeURIComponent(entry.exerciseId)}`,
        attribution: 'ExerciseDB OSS GIF',
        width: 1,
        height: 1,
        mime: 'image/gif',
    }
}

function uniqueCompact(values: Array<string | null | undefined>): string[] {
    const out: string[] = []
    const seen = new Set<string>()
    for (const raw of values) {
        const value = raw?.trim()
        if (!value) continue
        const key = value.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        out.push(value)
    }
    return out
}

function writeCache(key: string, value: ExerciseDbGifEntry[]): void {
    CACHE.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS })
    if (CACHE.size > CACHE_MAX_ENTRIES) {
        const overflow = CACHE.size - CACHE_MAX_ENTRIES
        const iter = CACHE.keys()
        for (let i = 0; i < overflow; i++) {
            const k = iter.next().value
            if (k !== undefined) CACHE.delete(k)
        }
    }
}

export function __clearExerciseGifCacheForTesting(): void {
    CACHE.clear()
}
