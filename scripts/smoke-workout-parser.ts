/**
 * Smoke test for the workout artifact foundation (Phase 1).
 *
 * Validates the pure-logic pieces:
 *   - Schema parses minimal and rich valid inputs across every exercise kind.
 *   - Schema rejects malformed inputs with a useful error path:
 *       - weighted set without weightKg/weightPct
 *       - superset with unequal planned-set counts
 *       - bad RPE / RIR
 *       - non-kebab-case exercise id
 *       - missing required muscle groups
 *   - estimated1RM produces sensible numbers; weightForReps inverts cleanly.
 *   - calculatePlates loads metric stacks correctly; reports remainders.
 *   - format helpers handle weight, duration, distance, rep ranges, set sequences.
 *   - progression suggests next target according to each rule.
 *
 * No network. The renderer is exercised by browser preview later.
 *
 * Run: npx tsx scripts/smoke-workout-parser.ts
 */
import { parseWorkoutArtifact } from '@/lib/workout/parser'
import { estimated1RM, epley1RM, brzycki1RM, weightForReps } from '@/lib/workout/one-rep-max'
import { calculatePlates, formatPlatePlan } from '@/lib/workout/plate-calc'
import {
    formatDistance,
    formatDuration,
    formatMinutes,
    formatRepRange,
    formatSetSequence,
    formatWeight,
    formatWeightNumber,
    totalVolume,
} from '@/lib/workout/format'
import { suggestNextTarget } from '@/lib/workout/progression'

let failures = 0
function check(label: string, cond: unknown, detail?: unknown) {
    const ok = Boolean(cond)
    console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  (' + JSON.stringify(detail) + ')'}`)
    if (!ok) failures++
}

// --- schema: minimal valid -------------------------------------------------

const minimal = {
    sessionId: 'sess-001',
    title: 'Test workout',
    units: 'kg' as const,
    groups: [
        {
            kind: 'straight' as const,
            exercises: [
                {
                    id: 'bench-press',
                    name: 'Bench Press',
                    kind: 'weighted' as const,
                    muscleGroups: ['chest', 'triceps'] as const,
                    planned: [
                        { weightKg: 60, reps: 8 },
                    ],
                },
            ],
        },
    ],
}

{
    const r = parseWorkoutArtifact(JSON.stringify(minimal))
    check('schema: minimal workout parses', r.ok, r)
    if (r.ok) {
        check('schema: title preserved', r.value.title === 'Test workout')
        check('schema: units default applied', r.value.units === 'kg')
        check('schema: working set default kind', (r.value.groups[0].exercises[0].planned[0] as { kind: string }).kind === 'working')
    }
}

// --- schema: rich valid (every exercise kind) ------------------------------

const rich = {
    sessionId: '2026-05-25-push-day',
    title: 'Push Day · Săpt 4',
    subtitle: 'Top set la bench, accesorii pentru volum.',
    program: { name: 'PPL', week: 4, day: 1, sessionN: 28 },
    estimatedDurationMin: 75,
    difficulty: 'greu',
    units: 'kg',
    barWeightKg: 20,
    plateIncrements: [25, 20, 15, 10, 5, 2.5, 1.25],
    trackRpe: true,
    autoStartRest: true,
    restAlertSec: 5,
    warmup: {
        items: ['5 min bike', '2 sets light bench (20kg × 10)', 'Band pull-aparts × 15'],
        estimatedMinutes: 10,
    },
    groups: [
        {
            kind: 'straight',
            exercises: [
                {
                    id: 'bench-press',
                    name: 'Bench Press',
                    kind: 'weighted',
                    equipment: ['barbell', 'bench', 'rack'],
                    muscleGroups: ['chest', 'triceps', 'front_delt'],
                    formCues: ['Scapulae retracted', 'Bar path slight diagonal toward shoulders'],
                    defaultRestSec: 150,
                    previous: {
                        date: '2026-05-21',
                        bestSet: { weightKg: 60, reps: 8, rpe: 8 },
                        allSets: [
                            { weightKg: 60, reps: 8, rpe: 7.5 },
                            { weightKg: 60, reps: 8, rpe: 8 },
                            { weightKg: 60, reps: 7, rpe: 9 },
                        ],
                    },
                    personalBest: { weightKg: 65, reps: 8, estimated1RM: 80, achievedAt: '2026-05-12' },
                    progression: { rule: 'double_progression', increment: 2.5, target: { reps: [6, 8] } },
                    planned: [
                        { kind: 'warmup', weightKg: 40, reps: 5 },
                        { kind: 'top_set', weightKg: 62.5, reps: [6, 8], rpe: 8, restSec: 180 },
                        { weightKg: 60, reps: [6, 8], rpe: 8 },
                        { weightKg: 60, reps: [6, 8], rpe: 8 },
                        { kind: 'amrap', weightKg: 55, reps: 0, notes: 'until failure' },
                    ],
                },
            ],
        },
        {
            kind: 'superset',
            label: 'Superset A',
            exercises: [
                {
                    id: 'incline-db-press',
                    name: 'Incline DB Press',
                    kind: 'weighted',
                    muscleGroups: ['chest', 'front_delt'],
                    planned: [
                        { weightKg: 22.5, reps: 10 },
                        { weightKg: 22.5, reps: 10 },
                        { weightKg: 22.5, reps: 10 },
                    ],
                },
                {
                    id: 'cable-fly',
                    name: 'Cable Fly',
                    kind: 'weighted',
                    muscleGroups: ['chest'],
                    planned: [
                        { weightKg: 15, reps: 15 },
                        { weightKg: 15, reps: 15 },
                        { weightKg: 15, reps: 15 },
                    ],
                },
            ],
        },
        {
            kind: 'straight',
            exercises: [
                {
                    id: 'weighted-pullups',
                    name: 'Weighted Pull-ups',
                    kind: 'weighted_bw',
                    muscleGroups: ['lats', 'biceps'],
                    planned: [
                        { weightKg: 10, reps: 5 },
                        { weightKg: 10, reps: 5 },
                    ],
                },
                {
                    id: 'dips',
                    name: 'Dips',
                    kind: 'bodyweight',
                    muscleGroups: ['chest', 'triceps'],
                    planned: [
                        { reps: 12 },
                        { reps: [8, 12] },
                    ],
                },
                {
                    id: 'plank',
                    name: 'Plank',
                    kind: 'hold',
                    muscleGroups: ['abs', 'lower_back'],
                    planned: [
                        { durationSec: 60 },
                        { durationSec: 45 },
                    ],
                },
                {
                    id: 'tabata-burpees',
                    name: 'Tabata Burpees',
                    kind: 'interval',
                    muscleGroups: ['full_body', 'cardio'],
                    planned: [
                        { rounds: 8, workSec: 20, intraRestSec: 10 },
                    ],
                },
                {
                    id: 'easy-bike',
                    name: 'Easy Bike',
                    kind: 'cardio_dur',
                    muscleGroups: ['cardio'],
                    planned: [
                        { durationSec: 600, targetMetric: 'Z2 HR' },
                    ],
                },
                {
                    id: 'cooldown-run',
                    name: 'Cooldown Run',
                    kind: 'cardio_dist',
                    muscleGroups: ['cardio'],
                    planned: [
                        { distanceM: 1000, targetMetric: '6:00/km' },
                    ],
                },
            ],
        },
    ],
    cooldown: { items: ['Stretching 5 min', 'Foam roll IT band'] },
    generatedAt: '2026-05-25T10:00:00Z',
    notes: 'Deload next week.',
}

{
    const r = parseWorkoutArtifact(JSON.stringify(rich))
    check('schema: rich workout parses (all 7 exercise kinds)', r.ok, r)
    if (r.ok) {
        check('schema: superset preserved', r.value.groups[1].kind === 'superset')
        check('schema: previous snapshot intact', r.value.groups[0].exercises[0].previous?.allSets?.length === 3)
        check('schema: PB present', r.value.groups[0].exercises[0].personalBest?.weightKg === 65)
        check('schema: warmup checklist parsed', r.value.warmup?.items.length === 3)
        check('schema: interval rounds preserved', (r.value.groups[2].exercises[3].planned[0] as { rounds: number }).rounds === 8)
    }
}

// --- schema: invalid inputs ------------------------------------------------

{
    const r = parseWorkoutArtifact('not json {')
    check('schema: invalid JSON has clear error', !r.ok && r.error.startsWith('Invalid JSON:'))
}

{
    const bad = { ...minimal, title: '' }
    const r = parseWorkoutArtifact(JSON.stringify(bad))
    check('schema: empty title rejected', !r.ok && r.error.startsWith('title:'))
}

{
    // weighted set with no weightKg / weightPct
    const bad = JSON.parse(JSON.stringify(minimal))
    bad.groups[0].exercises[0].planned[0] = { reps: 8 }
    const r = parseWorkoutArtifact(JSON.stringify(bad))
    check(
        'schema: weighted set without weight rejected',
        !r.ok && /weightKg or weightPct/.test(r.error),
        r,
    )
}

{
    // superset with unequal planned counts
    const bad = JSON.parse(JSON.stringify(rich))
    bad.groups[1].exercises[1].planned = [{ weightKg: 15, reps: 15 }] // 1 set vs other's 3
    const r = parseWorkoutArtifact(JSON.stringify(bad))
    check(
        'schema: superset with unequal set counts rejected',
        !r.ok && /equal planned set counts/.test(r.error),
        r,
    )
}

{
    // bad id (uppercase + space)
    const bad = JSON.parse(JSON.stringify(minimal))
    bad.groups[0].exercises[0].id = 'Bench Press'
    const r = parseWorkoutArtifact(JSON.stringify(bad))
    check(
        'schema: non-kebab-case id rejected',
        !r.ok && /id must be kebab-case/.test(r.error),
        r,
    )
}

{
    // missing muscleGroups
    const bad = JSON.parse(JSON.stringify(minimal))
    bad.groups[0].exercises[0].muscleGroups = []
    const r = parseWorkoutArtifact(JSON.stringify(bad))
    check(
        'schema: empty muscleGroups rejected',
        !r.ok && /muscleGroups/.test(r.error),
        r,
    )
}

{
    // bad RPE (12 — out of range)
    const bad = JSON.parse(JSON.stringify(minimal))
    bad.groups[0].exercises[0].planned[0] = { weightKg: 60, reps: 8, rpe: 12 }
    const r = parseWorkoutArtifact(JSON.stringify(bad))
    check('schema: RPE > 10 rejected', !r.ok && /rpe/.test(r.error), r)
}

{
    // rep range with low > high
    const bad = JSON.parse(JSON.stringify(minimal))
    bad.groups[0].exercises[0].planned[0] = { weightKg: 60, reps: [10, 5] }
    const r = parseWorkoutArtifact(JSON.stringify(bad))
    check('schema: inverted rep range rejected', !r.ok && /low must be/.test(r.error), r)
}

{
    // superset with only 1 exercise
    const bad = JSON.parse(JSON.stringify(minimal))
    bad.groups[0].kind = 'superset'
    const r = parseWorkoutArtifact(JSON.stringify(bad))
    check(
        'schema: superset with 1 exercise rejected',
        !r.ok && /at least 2 exercises/.test(r.error),
        r,
    )
}

// --- one-rep-max -----------------------------------------------------------

check('1RM: epley 100×5 ≈ 116.67', Math.abs((epley1RM(100, 5) ?? 0) - 116.667) < 0.01)
check('1RM: brzycki 100×5 = 112.5', brzycki1RM(100, 5) === 112.5)
check('1RM: estimated 100×5 ≈ 114.5 (rounded 0.5)', estimated1RM(100, 5) === 114.5)
check('1RM: 100×1 returns 100', estimated1RM(100, 1) === 100)
check('1RM: 0 weight rejected', estimated1RM(0, 5) === null)
check('1RM: 0 reps rejected', estimated1RM(100, 0) === null)
check('1RM: brzycki at r=37 rejected', brzycki1RM(100, 37) === null)
check('1RM: invert — weightForReps(114.5, 5) ≈ 100', Math.abs((weightForReps(114.5, 5) ?? 0) - 100) < 1)

// --- plate-calc ------------------------------------------------------------

{
    const p = calculatePlates(60)
    check('plate: 60kg = 20+ per side (20+5+...)', p !== null && p.actualKg === 60 && p.perSide.length === 1, p)
}

{
    const p = calculatePlates(100)
    // Greedy: largest-plate-first. With [25,20,15,10,5,2.5,1.25] it picks 25+15
    // (also 40kg, also 2 plates) instead of 20+20 — algorithmically equivalent.
    // Validate the math, not the specific stack.
    check('plate: 100kg = 40 per side exactly', p !== null && p.actualKg === 100 && perSideSum(p.perSide) === 40, p)
}

{
    const p = calculatePlates(102.5)
    // 102.5 → bar(20) + 41.25 per side. Default stack reaches this via
    // 25 + 15 + 1.25 (the 1.25 micro-plate fills the gap).
    check('plate: 102.5kg loads exactly', p !== null && p.actualKg === 102.5 && perSideSum(p.perSide) === 41.25, p)
}

function perSideSum(perSide: number[]): number {
    return Math.round(perSide.reduce((s, p) => s + p, 0) * 100) / 100
}

{
    const p = calculatePlates(20)
    check('plate: 20kg = bar only', p !== null && p.perSide.length === 0 && p.actualKg === 20, p)
}

{
    const p = calculatePlates(15)
    check('plate: 15kg < bar = null', p === null)
}

{
    const p = calculatePlates(60.3)
    check(
        'plate: 60.3kg gets remainder note',
        p !== null && p.remainderKg > 0 && p.remainderKg < 0.5,
        p,
    )
}

{
    const p = calculatePlates(102.5)
    if (p) check('plate: format string mentions per side', formatPlatePlan(p).includes('per side'))
}

// --- format ----------------------------------------------------------------

check('format: weight 60 kg', formatWeight(60, 'kg') === '60 kg')
check('format: weight 62.5 lb', formatWeight(62.5, 'lb') === '62.5 lb')
check('format: weight 60.001 trimmed → 60', formatWeightNumber(60.001) === '60')
check('format: duration 90s = 1:30', formatDuration(90) === '1:30')
check('format: duration 3661s = 1:01:01', formatDuration(3661) === '1:01:01')
check('format: duration 0 = 0:00', formatDuration(0) === '0:00')
check('format: minutes 45 = "45 min"', formatMinutes(45) === '45 min')
check('format: minutes 90 = "1 h 30 min"', formatMinutes(90) === '1 h 30 min')
check('format: minutes 120 = "2 h"', formatMinutes(120) === '2 h')
check('format: distance 5000m kg = "5 km"', formatDistance(5000, 'kg') === '5 km')
check('format: distance 5500m kg = "5.5 km"', formatDistance(5500, 'kg') === '5.5 km')
check('format: distance 400m kg = "400 m"', formatDistance(400, 'kg') === '400 m')
check('format: rep range single 8 = "8"', formatRepRange(8) === '8')
check('format: rep range [6,10] = "6-10"', formatRepRange([6, 10]) === '6-10')
check('format: rep range [8,8] collapses to "8"', formatRepRange([8, 8]) === '8')
check(
    'format: set sequence 60/60/57 × 8/8/7',
    formatSetSequence([
        { weightKg: 60, reps: 8 },
        { weightKg: 60, reps: 8 },
        { weightKg: 57, reps: 7 },
    ]) === '60/60/57 × 8/8/7',
)
check(
    'format: set sequence (duration only) = 1:00 / 0:45',
    formatSetSequence([{ durationSec: 60 }, { durationSec: 45 }]) === '1:00 / 0:45',
)
check(
    'format: total volume sum',
    totalVolume([
        { weightKg: 60, reps: 8 },
        { weightKg: 60, reps: 8 },
        { weightKg: 57, reps: 7 },
    ]) === 60 * 8 + 60 * 8 + 57 * 7,
)

// --- progression -----------------------------------------------------------

{
    const s = suggestNextTarget(
        { rule: 'linear', increment: 2.5 },
        { date: '2026-05-21', bestSet: { weightKg: 60, reps: 8 } },
        {},
    )
    check('progression: linear adds 2.5kg', s.weightKg === 62.5 && s.reps === 8)
}

{
    const s = suggestNextTarget(
        { rule: 'linear', increment: 2.5 },
        { date: '2026-05-21', bestSet: { weightKg: 60, reps: 8 } },
        { previousFailed: true },
    )
    check('progression: linear holds on failure', s.weightKg === 60 && s.reps === 8)
}

{
    const s = suggestNextTarget(
        { rule: 'double_progression', increment: 2.5, target: { reps: [6, 8] } },
        { date: '2026-05-21', bestSet: { weightKg: 60, reps: 8 } },
        {},
    )
    check(
        'progression: double_progression bumps weight at top of range',
        s.weightKg === 62.5 && Array.isArray(s.reps) && s.reps[0] === 6,
    )
}

{
    const s = suggestNextTarget(
        { rule: 'double_progression', increment: 2.5, target: { reps: [6, 8] } },
        { date: '2026-05-21', bestSet: { weightKg: 60, reps: 6 } },
        {},
    )
    check(
        'progression: double_progression adds reps below top',
        s.weightKg === 60 && Array.isArray(s.reps) && s.reps[0] === 7,
    )
}

{
    const s = suggestNextTarget(
        { rule: 'rpe_target', increment: 2.5, target: { rpe: 8 } },
        { date: '2026-05-21', bestSet: { weightKg: 60, reps: 8, rpe: 6 } },
        {},
    )
    check(
        'progression: rpe_target adds weight when RPE below target',
        s.weightKg === 62.5,
    )
}

{
    const s = suggestNextTarget({ rule: 'linear', increment: 2.5 }, undefined, {})
    check('progression: no previous returns null weight + rationale', s.weightKg === null && s.rationale.length > 0)
}

// --- summary ---------------------------------------------------------------

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
