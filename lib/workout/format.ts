import type { RepRange, WorkoutUnits } from './schema'

/**
 * Display helpers for the workout renderer.
 *
 * All formatting decisions live here so the renderer subcomponents can stay
 * focused on layout. Pure functions, easy to unit-test.
 */

/** "8" or "6-10" — a rep range as a compact string. */
export function formatRepRange(range: RepRange): string {
    if (typeof range === 'number') return range.toString()
    const [lo, hi] = range
    if (lo === hi) return lo.toString()
    return `${lo}-${hi}`
}

/** "60 kg" or "135 lb" with trailing-zero trimming and locale-neutral output. */
export function formatWeight(weight: number, units: WorkoutUnits): string {
    return `${formatWeightNumber(weight)} ${units}`
}

/**
 * "60" with trailing-zero trimming. Used when the unit is rendered separately
 * (set row weight column where the unit is implicit from the artifact units).
 */
export function formatWeightNumber(weight: number): string {
    if (!Number.isFinite(weight)) return ''
    // Round to nearest 0.25 to absorb floating-point noise from scaling.
    const rounded = Math.round(weight * 4) / 4
    if (Number.isInteger(rounded)) return rounded.toString()
    return rounded.toFixed(2).replace(/\.?0+$/, '')
}

/**
 * "1:23" / "12:34" / "1:23:45" — duration MM:SS or H:MM:SS.
 * Used for hold times, rest timers, total session time.
 */
export function formatDuration(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
    const s = Math.floor(seconds % 60)
    const m = Math.floor(seconds / 60) % 60
    const h = Math.floor(seconds / 3600)
    const pad2 = (n: number) => n.toString().padStart(2, '0')
    if (h > 0) return `${h}:${pad2(m)}:${pad2(s)}`
    return `${m}:${pad2(s)}`
}

/**
 * "45 min" / "1 h 30 min" — human duration for header rows.
 * Drops the minutes part when it's 0 ("2 h" not "2 h 0 min").
 */
export function formatMinutes(min: number): string {
    if (!Number.isFinite(min) || min <= 0) return ''
    if (min < 60) return `${Math.round(min)} min`
    const h = Math.floor(min / 60)
    const m = Math.round(min % 60)
    if (m === 0) return `${h} h`
    return `${h} h ${m} min`
}

/**
 * "5 km" / "400 m" / "2.4 km" — distance formatting for cardio.
 * Switches unit based on magnitude; the underlying schema always stores
 * meters so the conversion is centralized here.
 */
export function formatDistance(meters: number, units: WorkoutUnits): string {
    if (!Number.isFinite(meters) || meters < 0) return ''
    if (units === 'lb') {
        // Imperial-aligned display: yards/miles.
        const yards = meters * 1.0936133
        if (yards >= 880) {
            const mi = yards / 1760
            return `${mi.toFixed(mi < 10 ? 2 : 1)} mi`
        }
        return `${Math.round(yards)} yd`
    }
    if (meters >= 1000) {
        const km = meters / 1000
        // Strip trailing zeros so 5000m reads as "5 km" not "5.00 km".
        const formatted = km.toFixed(km < 10 ? 2 : 1).replace(/\.?0+$/, '')
        return `${formatted} km`
    }
    return `${Math.round(meters)} m`
}

/**
 * Pretty label for a SetKind, used in tooltips and the set-row badge.
 */
export function formatSetKind(kind: string): string {
    switch (kind) {
        case 'warmup': return 'Warm-up'
        case 'working': return 'Working'
        case 'top_set': return 'Top set'
        case 'back_off': return 'Back-off'
        case 'drop_set': return 'Drop set'
        case 'amrap': return 'AMRAP'
        case 'cluster': return 'Cluster'
        default: return kind
    }
}

/**
 * Label for a GroupKind. Used as the group card header when no explicit
 * `label` is provided.
 */
export function formatGroupKind(kind: string): string {
    switch (kind) {
        case 'straight': return ''
        case 'superset': return 'Superset'
        case 'circuit': return 'Circuit'
        case 'giant_set': return 'Giant Set'
        default: return kind
    }
}

/**
 * Difficulty label.
 */
export function formatDifficulty(kind: string): string {
    switch (kind) {
        case 'usor': return 'Easy'
        case 'mediu': return 'Medium'
        case 'greu': return 'Hard'
        case 'brutal': return 'Brutal'
        default: return kind
    }
}

/**
 * Total tonnage (volume) for an array of completed sets: sum of weight × reps.
 * Ignores sets without weight or reps. Used in the summary card.
 */
export function totalVolume(
    sets: Array<{ weightKg?: number; reps?: number }>,
): number {
    return sets.reduce((sum, s) => {
        if (s.weightKg === undefined || s.reps === undefined) return sum
        return sum + s.weightKg * s.reps
    }, 0)
}

/**
 * Compact "60/60/57 × 8/8/7" style string for the previous-session line.
 * Returns "" when sets is empty or all sets lack data.
 */
export function formatSetSequence(
    sets: Array<{ weightKg?: number; load?: number; reps?: number; durationSec?: number }>,
): string {
    if (sets.length === 0) return ''
    const weights = sets.map((s) => s.weightKg)
    const loads = sets.map((s) => s.load)
    const reps = sets.map((s) => s.reps)
    const durations = sets.map((s) => s.durationSec)

    const allDurations = durations.every((d) => typeof d === 'number')
    if (allDurations) {
        return durations.map((d) => formatDuration(d as number)).join(' / ')
    }

    const hasWeights = weights.some((w) => typeof w === 'number')
    const hasLoads = loads.some((load) => typeof load === 'number')
    const hasReps = reps.some((r) => typeof r === 'number')
    if (hasWeights && hasReps) {
        const wStr = weights.map((w) => (typeof w === 'number' ? formatWeightNumber(w) : '–')).join('/')
        const rStr = reps.map((r) => (typeof r === 'number' ? r.toString() : '–')).join('/')
        return `${wStr} × ${rStr}`
    }
    if (hasLoads && hasReps) {
        const loadStr = loads.map((load) => (typeof load === 'number' ? formatWeightNumber(load) : '–')).join('/')
        const repStr = reps.map((rep) => (typeof rep === 'number' ? rep.toString() : '–')).join('/')
        return `${loadStr} × ${repStr}`
    }
    if (hasReps) {
        return reps.map((r) => (typeof r === 'number' ? r.toString() : '–')).join(' / ')
    }
    return ''
}
