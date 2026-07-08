import { z } from 'zod'

// ---------------------------------------------------------------------------
// Model-tolerance coercions.
//
// The strict schema rejects the whole artifact on the first mismatch, and
// models (GPT-family especially) reliably make a few *shape-equivalent* slips
// that carry no ambiguity: a `notes` field emitted as an array of bullet
// strings instead of one string, or a number emitted as a numeric string
// ("39"). Coercing these at parse time — mirroring the existing `difficulty`
// alias below — turns a first-attempt rejection into a clean parse instead of
// burning a repair round-trip (the confirmed real-world failure was gpt-5.5
// emitting root `notes` as an array). We convert ONLY when the intent is
// unambiguous; anything else passes through untouched so the wrapped schema
// still reports a precise error (e.g. a letter day "A" is not numeric, so it
// stays a string and is still rejected — repair handles it).
// ---------------------------------------------------------------------------

/** Join an array of strings into one newline-separated string; leave scalars
 *  untouched. A blank/empty array becomes undefined so `.optional()` holds. */
function coerceTextArray(value: unknown): unknown {
    if (!Array.isArray(value)) return value
    const parts = value
        .filter((v): v is string => typeof v === 'string')
        .map((v) => v.trim())
        .filter((v) => v.length > 0)
    return parts.length ? parts.join('\n') : undefined
}

/** Coerce a numeric-looking string ("39", " 2.5 ") to a number. Leaves
 *  non-numeric strings (e.g. a letter day "A") and every other type as-is so
 *  the wrapped numeric schema still rejects them with a precise message. */
function coerceNumericString(value: unknown): unknown {
    if (typeof value !== 'string') return value
    const trimmed = value.trim()
    if (trimmed === '') return value
    const n = Number(trimmed)
    return Number.isFinite(n) ? n : value
}

/** Wrap a string schema so array-of-strings input is joined into one string. */
const flexibleText = (schema: z.ZodString) => z.preprocess(coerceTextArray, schema)
/** Wrap a numeric schema so numeric-string input is coerced to a number. */
const num = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(coerceNumericString, schema)
/** Coerce a rep range: a numeric string → number, an array → its elements
 *  each coerced, so `["6","10"]` becomes `[6, 10]`. */
function coerceRepRange(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(coerceNumericString)
    return coerceNumericString(value)
}

// ---------------------------------------------------------------------------
// Workout artifact domain schema.
//
// A `WorkoutArtifact` is the JSON payload the orchestrator emits inside an
// `<artifact type="application/vnd.ant.workout">` block. The renderer parses
// this with Zod and hands the validated shape to a native React UI (sticky
// progress bar, per-exercise card with last-session + PR context, set rows
// with check / weight picker / reps picker, floating rest timer, summary).
//
// Design choices that lock the shape in early so it can be versioned cleanly:
//
//   - Exercise.kind is a discriminated union. A barbell bench press has
//     `weightKg` + `reps`; a plank has `durationSec`; an interval run has
//     `workSec`/`restSec`/`rounds`. Putting one shape with everything
//     optional pushed bugs into the renderer ("why is durationSec showing
//     on bench press?"). The union forces the model to pick a kind and
//     emit only the fields that make sense.
//
//   - Sets are split into `planned` (what the model prescribed) and `logged`
//     (what the user actually did). The renderer hydrates `logged` from
//     localStorage / API in Phase 2; Phase 1 ships read-only with planned
//     rendered as targets and previous-session data shown as context.
//
//   - Groups model supersets / circuits explicitly. A "straight" group with
//     one exercise is the default for a normal strength workout. Supersets
//     and circuits change rest behaviour (rest after the last exercise in
//     the group, not after each) so we need this in the schema, not invented
//     by the renderer.
//
//   - `previous` and `personalBest` are populated by the server before the
//     model emits the artifact — the model calls a `getExerciseHistory`
//     tool, gets back a snapshot, and bakes it into the artifact. The
//     renderer never fetches; it just renders what's in the JSON.
//
//   - Units live on the root, not per-exercise. The whole workout is in kg
//     or lb. Mixing per-exercise is too edge-case to be worth the surface.
//
//   - Bar weight and plate increments are optional and override the user's
//     global default. Useful for workouts that specify a particular setup
//     (deadlift on an oly bar vs. trap bar, technique bar for warmups).
//
//   - sessionId is required and stable across artifact versions, so
//     localStorage autosave keeps the same key whether the artifact rerenders.
//
// This module imports only zod — it sits at the bottom of the import graph
// so both the server-side validator and the client-side renderer can depend
// on it without cycles.
// ---------------------------------------------------------------------------

// === primitives ============================================================

/**
 * The unit system for the whole workout. Always stored in the user's preferred
 * system; never mixed within a single artifact. The renderer reads this to
 * format weight labels (`kg` / `lb`).
 */
export const WorkoutUnitsSchema = z.enum(['kg', 'lb'])
export type WorkoutUnits = z.infer<typeof WorkoutUnitsSchema>

/**
 * Difficulty hint surfaced in the header. Subjective — set by the model
 * based on intensity / volume relative to the user's logged baseline.
 */
const WORKOUT_DIFFICULTY_ALIASES: Record<string, 'usor' | 'mediu' | 'greu' | 'brutal'> = {
    beginner: 'usor',
    easy: 'usor',
    light: 'usor',
    moderate: 'mediu',
    medium: 'mediu',
    intermediate: 'mediu',
    hard: 'greu',
    advanced: 'greu',
    intense: 'greu',
    brutal: 'brutal',
}

export const WorkoutDifficultySchema = z.preprocess((value) => {
    if (typeof value !== 'string') return value
    const normalized = value.trim().toLowerCase()
    return WORKOUT_DIFFICULTY_ALIASES[normalized] ?? normalized
}, z.enum(['usor', 'mediu', 'greu', 'brutal']))
export type WorkoutDifficulty = z.infer<typeof WorkoutDifficultySchema>

/**
 * Equipment chips shown in the header. The renderer maps each to a small
 * icon + label so the user can see at a glance what they'll need.
 */
export const WorkoutEquipmentSchema = z.enum([
    'barbell',
    'dumbbell',
    'kettlebell',
    'machine',
    'cable',
    'bodyweight',
    'band',
    'plates',
    'bench',
    'rack',
    'pullup_bar',
    'box',
    'rower',
    'bike',
    'treadmill',
    'sled',
    'rings',
    'trx',
    'mat',
    'foam_roller',
    'jump_rope',
    'other',
])
export type WorkoutEquipment = z.infer<typeof WorkoutEquipmentSchema>

/**
 * Muscle group taxonomy — coarse but consistent. Used for grouping summaries
 * (chest day vs. back day), volume tracking, and substitution suggestions.
 * Renderer shows these as small chips under the exercise name.
 */
export const MuscleGroupSchema = z.enum([
    // Push
    'chest', 'front_delt', 'side_delt', 'rear_delt', 'triceps',
    // Pull
    'lats', 'mid_back', 'traps', 'rhomboids', 'biceps', 'forearms',
    // Lower
    'quads', 'hamstrings', 'glutes', 'calves', 'adductors', 'abductors',
    // Core
    'abs', 'obliques', 'lower_back',
    // Whole body
    'full_body', 'cardio',
])
export type MuscleGroup = z.infer<typeof MuscleGroupSchema>

/**
 * Set kind drives visual treatment and progression logic.
 *   - `warmup`     — gray text, excluded from progression
 *   - `working`    — the default
 *   - `top_set`    — accent border-left, source for "best set" tracking
 *   - `back_off`   — slightly muted, after a top set
 *   - `drop_set`   — amber tint, no rest before
 *   - `amrap`      — violet glow, push to failure
 *   - `cluster`    — mini-pauses inside (5×3 with 15s pauses, treated as one set)
 */
export const SetKindSchema = z.enum([
    'warmup',
    'working',
    'top_set',
    'back_off',
    'drop_set',
    'amrap',
    'cluster',
])
export type SetKind = z.infer<typeof SetKindSchema>

/**
 * Grouping kind for ExerciseGroup. Drives rest behavior:
 *   - `straight`  — finish all sets of one exercise before the next; rest
 *                   between every set.
 *   - `superset`  — alternate two exercises; rest after second one each round.
 *   - `circuit`   — rotate through 3+ exercises; rest after the last.
 *   - `giant_set` — same as circuit but 4+ exercises (label-only distinction).
 */
export const GroupKindSchema = z.enum(['straight', 'superset', 'circuit', 'giant_set'])
export type GroupKind = z.infer<typeof GroupKindSchema>

/**
 * Progression rule. The server uses this on the next session to suggest a
 * new target. The renderer doesn't act on it — it's a hint that lives in
 * the artifact so it survives roundtrips.
 *   - `linear`              — fixed weight increment when all reps completed
 *   - `double_progression`  — add reps until top of range; then +weight, reset
 *   - `rpe_target`          — adjust weight to hit a target RPE
 *   - `percentage`          — based on a percent of estimated 1RM
 *   - `none`                — no automatic suggestion
 */
export const ProgressionRuleSchema = z.enum([
    'linear',
    'double_progression',
    'rpe_target',
    'percentage',
    'none',
])
export type ProgressionRule = z.infer<typeof ProgressionRuleSchema>

/**
 * RPE (Rate of Perceived Exertion): 1..10. Half-steps allowed (7.5).
 * Bounded so the model can't emit nonsense like 12.
 */
const RpeSchema = num(z.number().min(1).max(10))

/**
 * RIR (Reps in Reserve): 0..5. Alternative tracking style to RPE — some
 * people prefer "I had 2 left in the tank" to "that was a 7.5 RPE".
 */
const RirSchema = num(z.number().int().min(0).max(5))

/**
 * Rep range. Either a single number ("8 reps") or a [low, high] interval
 * ("6-10 reps"). The renderer formats this as "8" or "6-10".
 */
const RepRangeSchema = z.preprocess(coerceRepRange, z.union([
    z.number().int().min(0).max(1000),
    z.tuple([
        z.number().int().min(0).max(1000),
        z.number().int().min(0).max(1000),
    ]).refine(([lo, hi]) => lo <= hi, {
        message: 'rep range low must be ≤ high',
    }),
]))
export type RepRange = z.infer<typeof RepRangeSchema>

// === planned set (discriminated by exercise kind) =========================

/**
 * Base fields shared by every planned set, regardless of exercise kind.
 * The set kind, optional rest override, optional RPE/RIR target, optional
 * inline notes ("tempo 3-1-1", "pause at chest") apply everywhere.
 */
const PlannedSetBaseSchema = z.object({
    /** Set type — drives visual treatment and progression. Default working. */
    kind: SetKindSchema.default('working'),
    /** Override the exercise-level defaultRestSec. Useful for drop sets (0)
     *  or top sets (longer rest). */
    restSec: num(z.number().int().min(0).max(1800)).optional(),
    /** Target RPE for the set. Mutually exclusive with RIR but we don't
     *  enforce — the renderer prefers RPE if both present. */
    rpe: RpeSchema.optional(),
    /** Target RIR. */
    rir: RirSchema.optional(),
    /** Inline notes shown next to the set. Tempo prescriptions, technique
     *  reminders specific to this set, etc. */
    notes: flexibleText(z.string().min(1).max(200)).optional(),
})

/** Weighted set: bench, squat, deadlift, dumbbell row, etc. */
const WeightedPlannedSetSchema = PlannedSetBaseSchema.extend({
    /** Absolute weight target — preferred over weightPct when both present. */
    weightKg: num(z.number().min(0).max(2000)).optional(),
    /** Alternative: percent of estimated 1RM. Renderer multiplies on display. */
    weightPct: num(z.number().min(0).max(200)).optional(),
    /** Target reps. Required for weighted sets. */
    reps: RepRangeSchema,
})

/** Bodyweight set: pullups, pushups, dips, sit-ups. Just reps. */
const BodyweightPlannedSetSchema = PlannedSetBaseSchema.extend({
    reps: RepRangeSchema,
})

/** Weighted bodyweight: weighted pullups (added kg) or assisted dips
 *  (negative kg means assistance). */
const WeightedBwPlannedSetSchema = PlannedSetBaseSchema.extend({
    /** Negative means assistance, positive means added weight. */
    weightKg: num(z.number().min(-200).max(200)).optional(),
    reps: RepRangeSchema,
})

/** Isometric hold: plank, hollow hold, L-sit, wall sit. */
const HoldPlannedSetSchema = PlannedSetBaseSchema.extend({
    /** Hold duration in seconds. */
    durationSec: num(z.number().int().min(1).max(3600)),
    /** Optional added load for weighted holds (weighted plank). */
    weightKg: num(z.number().min(0).max(500)).optional(),
})

/** Cardio by duration: 20 min easy bike, 10 min row Z2. */
const CardioDurPlannedSetSchema = PlannedSetBaseSchema.extend({
    durationSec: num(z.number().int().min(1).max(36000)),
    /** Optional target heart rate zone, watts (cycling), pace (m/s), etc. */
    targetMetric: z.string().min(1).max(60).optional(),
})

/** Cardio by distance: 5 km run, 2000 m row. */
const CardioDistPlannedSetSchema = PlannedSetBaseSchema.extend({
    distanceM: num(z.number().min(1).max(1_000_000)),
    /** Optional target pace ("4:30/km") or split time. */
    targetMetric: z.string().min(1).max(60).optional(),
})

/** Interval round: HIIT, Tabata, EMOM, intervals.
 *  Represents one round of work + rest; the planned set's `reps` field is
 *  reused as `rounds` count via the discriminator below. */
const IntervalPlannedSetSchema = PlannedSetBaseSchema.extend({
    /** Number of rounds inside this set (e.g. 8 for Tabata's 8-round structure). */
    rounds: num(z.number().int().min(1).max(200)),
    workSec: num(z.number().int().min(1).max(3600)),
    /** Rest between rounds inside the interval. The set-level restSec is
     *  the rest AFTER all rounds complete. */
    intraRestSec: num(z.number().int().min(0).max(600)).default(0),
    /** Optional movement variants per round if not uniform. */
    targetMetric: z.string().min(1).max(60).optional(),
})

export type PlannedSet =
    | z.infer<typeof WeightedPlannedSetSchema>
    | z.infer<typeof BodyweightPlannedSetSchema>
    | z.infer<typeof WeightedBwPlannedSetSchema>
    | z.infer<typeof HoldPlannedSetSchema>
    | z.infer<typeof CardioDurPlannedSetSchema>
    | z.infer<typeof CardioDistPlannedSetSchema>
    | z.infer<typeof IntervalPlannedSetSchema>

// === logged set (session state, mirrors planned with `actual*`) ============

/**
 * What the user actually did. Phase 1 carries this so the schema is
 * complete; Phase 2 will populate it from localStorage / save API. Empty
 * by default — the renderer treats absence as "not started yet".
 */
export const LoggedSetSchema = z.object({
    completed: z.boolean().default(false),
    /** Actual reps performed. */
    actualReps: z.number().int().min(0).max(1000).optional(),
    /** Actual weight loaded. For weighted_bw, negative = assistance. */
    actualWeightKg: z.number().min(-500).max(2000).optional(),
    /** Actual hold time. */
    actualDurationSec: z.number().int().min(0).max(36000).optional(),
    /** Actual distance covered. */
    actualDistanceM: z.number().min(0).max(1_000_000).optional(),
    /** User-reported RPE after the set. */
    actualRpe: RpeSchema.optional(),
    /** User-reported RIR. */
    actualRir: RirSchema.optional(),
    /** Set failed mid-rep. partialReps records how many reps were actually
     *  completed (e.g. failed at 6 of 8). */
    failed: z.boolean().optional(),
    partialReps: z.number().int().min(0).max(1000).optional(),
    /** Set intentionally skipped by the user. Used to advance the workout
     *  order without counting the set as completed volume. */
    skipped: z.boolean().optional(),
    /** Optional reason captured when the user skips a set. */
    skipReason: z.string().min(1).max(400).optional(),
    /** Free-form note: "shoulder felt tight", "form broke last 2 reps". */
    notes: z.string().min(1).max(400).optional(),
    /** ISO timestamps for set start (when the timer would have started)
     *  and complete (when the checkbox was tapped). */
    startedAt: z.string().min(1).max(40).optional(),
    completedAt: z.string().min(1).max(40).optional(),
})
export type LoggedSet = z.infer<typeof LoggedSetSchema>

// === exercise (discriminated union by kind) ================================

/**
 * Per-exercise progression hint. Server reads this on next session to
 * suggest the new target. Renderer ignores it in Phase 1.
 */
export const ProgressionConfigSchema = z.object({
    rule: ProgressionRuleSchema.default('none'),
    /** Increment in kg (or % depending on rule). */
    increment: num(z.number().min(0).max(500)).optional(),
    /** Target rep range or RPE for the rule. */
    target: z.object({
        reps: z.preprocess(coerceRepRange, z.tuple([
            z.number().int().min(0).max(1000),
            z.number().int().min(0).max(1000),
        ])).optional(),
        rpe: RpeSchema.optional(),
    }).optional(),
})
export type ProgressionConfig = z.infer<typeof ProgressionConfigSchema>

/**
 * Snapshot of the user's last session at this exercise. Server populates
 * this from `workouts/exercises/<slug>.json` before generation, so the
 * renderer doesn't need to fetch.
 */
export const PreviousSessionSnapshotSchema = z.object({
    /** ISO date YYYY-MM-DD of the last session. */
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be ISO date YYYY-MM-DD'),
    /** The single best set from that session (highest weight × reps product
     *  for weighted, longest hold, fastest pace, etc.). */
    bestSet: z.object({
        weightKg: num(z.number()).optional(),
        reps: num(z.number().int()).optional(),
        durationSec: num(z.number().int()).optional(),
        distanceM: num(z.number()).optional(),
        rpe: RpeSchema.optional(),
    }),
    /** All sets from that session, for compact "60/60/57 × 8/8/7" display. */
    allSets: z.array(z.object({
        weightKg: num(z.number()).optional(),
        reps: num(z.number().int()).optional(),
        durationSec: num(z.number().int()).optional(),
        distanceM: num(z.number()).optional(),
        rpe: RpeSchema.optional(),
    })).max(50).optional(),
})
export type PreviousSessionSnapshot = z.infer<typeof PreviousSessionSnapshotSchema>

/**
 * Personal best summary at this exercise. Triggers the PR badge in the
 * exercise header. Server populates from history.
 */
export const PersonalBestSchema = z.object({
    weightKg: num(z.number()).optional(),
    reps: num(z.number().int()).optional(),
    durationSec: num(z.number().int()).optional(),
    distanceM: num(z.number()).optional(),
    /** Estimated 1RM from the PR set (Epley / Brzycki average). Renderer
     *  shows this next to PB weight for quick "I'm at ~X 1RM" feel. */
    estimated1RM: num(z.number()).optional(),
    achievedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be ISO date YYYY-MM-DD'),
})
export type PersonalBest = z.infer<typeof PersonalBestSchema>

/**
 * Base fields shared by every exercise regardless of kind.
 */
const ExerciseBaseSchema = z.object({
    /** Stable id — used as the session log key and for history lookups.
     *  Kebab-case slug ("bench-press", "front-squat"). */
    id: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/, 'id must be kebab-case'),
    /** Display name: "Bench Press", "Front Squat". */
    name: z.string().min(1).max(120),
    /** Equipment chips for the exercise header. */
    equipment: z.array(WorkoutEquipmentSchema).max(6).optional(),
    /** Muscle groups worked. */
    muscleGroups: z.array(MuscleGroupSchema).min(1).max(8),
    /** Longer exercise description shown in the info popover. Useful for
     *  machine setup, seat/pad adjustment, range-of-motion notes, and
     *  "what this is supposed to feel like" guidance. */
    description: z.string().min(1).max(1000).optional(),
    /** Optional direct demo image/GIF. Include only when it is a stable,
     *  verified URL for this exact exercise/setup; the renderer resolves an
     *  ExerciseDB GIF first and may fall back to still-image search only when
     *  the user opens the exercise info panel. */
    imageUrl: z.string().url().max(2048).optional(),
    /** Optional demo GIF/image lookup query used by the renderer as a fallback
     *  when no direct `imageUrl` is available. Prefer `description`,
     *  `videoUrl`, or a verified `imageUrl` for exact machine setups. */
    imageQuery: z.string().min(1).max(180).optional(),
    /** Optional alternative movements the user can swap in when the prescribed
     *  exercise isn't available (no machine, injury, etc.). Renderer surfaces
     *  these in the (i) info panel under an "Alternatives" section. Each entry is
     *  a short free-form label ("Dumbbell incline press · 3×10",
     *  "Smith machine bench"). The model should pick alternatives that hit
     *  the same primary muscle groups. */
    alternatives: z.array(z.string().min(1).max(120)).max(5).optional(),
    /** Optional video URL (YouTube/Vimeo). Renderer shows a link-out with
     *  thumbnail; embed only on explicit user tap. */
    videoUrl: z.string().url().max(2048).optional(),
    /** Default rest after each set in this exercise (seconds). Override per
     *  set via PlannedSet.restSec. */
    defaultRestSec: num(z.number().int().min(0).max(1800)).optional(),
    /** Snapshot of last session for prefill / context. */
    previous: PreviousSessionSnapshotSchema.optional(),
    /** Personal best summary. */
    personalBest: PersonalBestSchema.optional(),
    /** Progression rule for the server to apply next time. */
    progression: ProgressionConfigSchema.optional(),
    /** Optional per-set logged data. Phase 2 hydrates this. */
    logged: z.array(LoggedSetSchema).max(60).optional(),
})

/** Weighted exercise: barbell / dumbbell / kettlebell / machine moves. */
const WeightedExerciseSchema = ExerciseBaseSchema.extend({
    kind: z.literal('weighted'),
    planned: z.array(WeightedPlannedSetSchema).min(1).max(40),
})

/** Bodyweight exercise: pullups, dips, pushups. */
const BodyweightExerciseSchema = ExerciseBaseSchema.extend({
    kind: z.literal('bodyweight'),
    planned: z.array(BodyweightPlannedSetSchema).min(1).max(40),
})

/** Weighted bodyweight: dips with belt, assisted pullups. */
const WeightedBwExerciseSchema = ExerciseBaseSchema.extend({
    kind: z.literal('weighted_bw'),
    planned: z.array(WeightedBwPlannedSetSchema).min(1).max(40),
})

/** Hold / isometric exercises. */
const HoldExerciseSchema = ExerciseBaseSchema.extend({
    kind: z.literal('hold'),
    planned: z.array(HoldPlannedSetSchema).min(1).max(40),
})

/** Cardio by duration. */
const CardioDurExerciseSchema = ExerciseBaseSchema.extend({
    kind: z.literal('cardio_dur'),
    planned: z.array(CardioDurPlannedSetSchema).min(1).max(40),
})

/** Cardio by distance. */
const CardioDistExerciseSchema = ExerciseBaseSchema.extend({
    kind: z.literal('cardio_dist'),
    planned: z.array(CardioDistPlannedSetSchema).min(1).max(40),
})

/** Intervals: HIIT, EMOM, Tabata, sprint intervals. */
const IntervalExerciseSchema = ExerciseBaseSchema.extend({
    kind: z.literal('interval'),
    planned: z.array(IntervalPlannedSetSchema).min(1).max(40),
})

export const ExerciseSchema = z.discriminatedUnion('kind', [
    WeightedExerciseSchema,
    BodyweightExerciseSchema,
    WeightedBwExerciseSchema,
    HoldExerciseSchema,
    CardioDurExerciseSchema,
    CardioDistExerciseSchema,
    IntervalExerciseSchema,
])
export type Exercise = z.infer<typeof ExerciseSchema>

// === group =================================================================

export const ExerciseGroupSchema = z.object({
    kind: GroupKindSchema.default('straight'),
    /** Optional label: "Superset A", "Push circuit". Renderer auto-generates
     *  a label from `kind` when omitted. */
    label: z.string().min(1).max(60).optional(),
    /** Rounds count for circuit / giant_set. Each exercise's `planned` sets
     *  represent one round when this is set; the renderer multiplies. Omit
     *  for `straight`/`superset` (sets already encode the work). */
    rounds: num(z.number().int().min(1).max(50)).optional(),
    /** Override default rest between rounds (for circuits) or between
     *  superset rounds. Per-set restSec still wins if specified. */
    restBetweenSec: num(z.number().int().min(0).max(1800)).optional(),
    exercises: z.array(ExerciseSchema).min(1).max(12),
})
export type ExerciseGroup = z.infer<typeof ExerciseGroupSchema>

// === warmup / cooldown =====================================================

/**
 * Loose checklist for the warmup or cooldown phase. Items are free-form
 * strings — the renderer shows a small bulleted list with bare checkboxes
 * (no log persistence in Phase 1). estimatedMinutes is a heuristic for the
 * total-time estimate.
 */
export const WorkoutChecklistSchema = z.object({
    items: z.array(z.string().min(1).max(240)).min(1).max(20),
    estimatedMinutes: num(z.number().int().min(0).max(120)).optional(),
})
export type WorkoutChecklist = z.infer<typeof WorkoutChecklistSchema>

// === program context ======================================================

/**
 * Optional program metadata — when the workout is part of a named program
 * (Stronglifts 5x5, PPL, Madcow), this drives the header's "Day 2 of 3, week
 * 4" line and lets the next-session button auto-pickup. Renderer is happy
 * without it; the model can include it when the user is on a structured
 * program.
 */
export const WorkoutProgramSchema = z.object({
    name: z.string().min(1).max(120),
    week: num(z.number().int().min(1).max(520)).optional(),
    day: num(z.number().int().min(1).max(10)).optional(),
    /** Total session number in the program — sequential across weeks. */
    sessionN: num(z.number().int().min(1).max(10000)).optional(),
})
export type WorkoutProgram = z.infer<typeof WorkoutProgramSchema>

// === root ==================================================================

export const WorkoutArtifactSchema = z.object({
    /** Stable session id — used as the localStorage / save-API key. The
     *  model MUST generate a fresh UUID each session and keep it across
     *  artifact updates within that session (e.g., if the renderer re-emits
     *  on rerun). */
    sessionId: z.string().min(1).max(80),
    /** Display title: "Push Day · Week 4". */
    title: z.string().min(1).max(160),
    /** Optional subtitle: "Focus on bench top set". */
    subtitle: z.string().min(1).max(280).optional(),
    /** Program metadata when part of a named program. */
    program: WorkoutProgramSchema.optional(),
    /** Estimated total session time (warmup + work + rest + cooldown). */
    estimatedDurationMin: num(z.number().int().min(1).max(600)).optional(),
    /** Difficulty hint. */
    difficulty: WorkoutDifficultySchema.optional(),

    /** Unit system for ALL weight/distance values in this artifact. */
    units: WorkoutUnitsSchema.default('kg'),
    /** Bar weight in kg (or lb, matching `units`). Default 20 (men's
     *  olympic). Renderer uses this for plate calculator. */
    barWeightKg: num(z.number().min(0).max(50)).optional(),
    /** Available plate sizes the user owns, descending. Used by plate
     *  calculator. Defaults to a reasonable kg set when omitted. */
    plateIncrements: z.array(num(z.number().min(0.1).max(100))).max(20).optional(),
    /** Whether to show RPE inputs in the UI. User pref override. */
    trackRpe: z.boolean().optional(),
    /** Whether to show RIR inputs. */
    trackRir: z.boolean().optional(),
    /** Auto-start rest timer on set check. */
    autoStartRest: z.boolean().optional(),
    /** Chime N seconds before rest timer ends. 0 = no early chime. */
    restAlertSec: num(z.number().int().min(0).max(60)).optional(),

    /** Optional warmup checklist shown above the first exercise. */
    warmup: WorkoutChecklistSchema.optional(),
    /** Main work: ordered list of groups. A straight group with one exercise
     *  is the default ("Bench Press, 4×8"); supersets/circuits use the
     *  group's `kind` and `rounds`. */
    groups: z.array(ExerciseGroupSchema).min(1).max(20),
    /** Optional cooldown checklist shown below the last exercise. */
    cooldown: WorkoutChecklistSchema.optional(),

    /** ISO timestamp when the session was generated. */
    generatedAt: z.string().min(1).max(40).optional(),
    /** ISO timestamp the user actually started (Start button). Phase 2
     *  populates; Phase 1 leaves undefined. */
    startedAt: z.string().min(1).max(40).optional(),
    /** ISO timestamp the user finished. */
    completedAt: z.string().min(1).max(40).optional(),

    /** Free-form notes from the model: "deload week, intensity 70%". Models
     *  often emit this as an array of bullet strings — we join those into one
     *  string rather than reject the whole artifact. */
    notes: flexibleText(z.string().min(1).max(800)).optional(),
    /** Attribution: program source, coach, original article. */
    attribution: z.string().min(1).max(200).optional(),
})
    .superRefine((workout, ctx) => {
        // Cross-field invariants. These catch model mistakes that the
        // per-field schemas can't see.

        // Each exercise's logged[] (if present) must not exceed its planned
        // length by more than a few free-form additions. Phase 2 allows
        // users to add ad-hoc sets, so we allow up to planned.length + 5.
        workout.groups.forEach((group, gi) => {
            group.exercises.forEach((ex, ei) => {
                if (ex.logged && ex.logged.length > ex.planned.length + 5) {
                    ctx.addIssue({
                        code: z.ZodIssueCode.custom,
                        path: ['groups', gi, 'exercises', ei, 'logged'],
                        message: `logged sets (${ex.logged.length}) exceed planned (${ex.planned.length}) by more than 5`,
                    })
                }
            })
        })

        // For superset / circuit / giant_set groups, every exercise must have
        // the SAME number of planned sets (one per round). Different counts
        // mean the model emitted something the UI can't render coherently.
        workout.groups.forEach((group, gi) => {
            if (group.kind === 'straight') return
            if (group.exercises.length < 2) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['groups', gi],
                    message: `${group.kind} group needs at least 2 exercises (got ${group.exercises.length})`,
                })
                return
            }
            const lengths = group.exercises.map((ex) => ex.planned.length)
            const first = lengths[0]
            const mismatched = lengths.some((l) => l !== first)
            if (mismatched) {
                ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ['groups', gi],
                    message: `${group.kind} group exercises must have equal planned set counts (got [${lengths.join(', ')}])`,
                })
            }
        })

        // Weighted sets MUST have either weightKg or weightPct (or be marked
        // bodyweight via the kind). Some models emit reps-only weighted
        // sets and the renderer would have nothing to show in the weight
        // column.
        workout.groups.forEach((group, gi) => {
            group.exercises.forEach((ex, ei) => {
                if (ex.kind !== 'weighted') return
                ex.planned.forEach((set, si) => {
                    if (set.weightKg === undefined && set.weightPct === undefined) {
                        ctx.addIssue({
                            code: z.ZodIssueCode.custom,
                            path: ['groups', gi, 'exercises', ei, 'planned', si],
                            message: `weighted set needs weightKg or weightPct (or change exercise kind to bodyweight)`,
                        })
                    }
                })
            })
        })
    })

export type WorkoutArtifact = z.infer<typeof WorkoutArtifactSchema>

// === parser result =========================================================

/** Result wrapper so the renderer can show a clear error message instead
 *  of silently rendering an empty card when the model emits malformed JSON. */
export type WorkoutArtifactParseResult =
    | { ok: true; value: WorkoutArtifact }
    // `error` is the first (most actionable) issue for the renderer's error
    // card; `issues` carries every validation issue so the repair pass can fix
    // them all in one round-trip instead of one-per-attempt.
    | { ok: false; error: string; issues?: string[] }
