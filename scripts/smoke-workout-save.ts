/**
 * Smoke test for save-session helpers.
 *
 * Validates the pure logic:
 *   - buildSessionLog produces correct aggregates
 *   - detectExercisePrs catches weight, rep, and 1RM PRs
 *   - mergeExerciseHistory dedupes by sessionId, caps at 12, updates PB
 *   - formatHistoryEntryLine / formatSessionMarkdown produce sane strings
 *   - buildPreviousFromHistory builds a schema-shaped previous snapshot
 *
 * No I/O. The route + storage layer is exercised through the live preview.
 *
 * Run: npx tsx scripts/smoke-workout-save.ts
 */
import { parseWorkoutArtifact } from '@/lib/workout/parser'
import { summarizeWorkoutForPrompt } from '@/lib/workout/prompt-context'
import { buildEffectiveWorkout } from '@/lib/workout/session-plan'
import {
    createRestState,
    normalizePersistedRestState,
    resolveTimedSetDraftDuration,
    sessionContentSignature,
    type WorkoutSessionState,
} from '@/lib/workout/use-workout-session'
import {
    buildSessionLog,
    buildSessionSlug,
    buildPreviousFromHistory,
    detectExercisePrs,
    formatHistoryEntryLine,
    formatSessionMarkdown,
    mergeExerciseHistory,
    type ExerciseHistory,
    type SessionLog,
} from '@/lib/workout/save-session'

let failures = 0
function check(label: string, cond: unknown, detail?: unknown) {
    const ok = Boolean(cond)
    console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : '  (' + JSON.stringify(detail) + ')'}`)
    if (!ok) failures++
}

// === fixtures ==============================================================

const minimalWorkoutJson = JSON.stringify({
    sessionId: 'sess-001',
    title: 'Test Push',
    units: 'kg',
    groups: [
        {
            kind: 'straight',
            exercises: [
                {
                    id: 'bench-press',
                    name: 'Bench Press',
                    kind: 'weighted',
                    equipment: ['barbell', 'bench'],
                    muscleGroups: ['chest'],
                    description: 'Set the shoulder blades, then press with control.',
                    personalBest: { weightKg: 60, reps: 8, estimated1RM: 73, achievedAt: '2026-05-12' },
                    planned: [
                        { weightKg: 60, reps: 8 },
                        { weightKg: 60, reps: 8 },
                        { weightKg: 60, reps: 8 },
                    ],
                },
            ],
        },
    ],
})

const workout = (() => {
    const r = parseWorkoutArtifact(minimalWorkoutJson)
    if (!r.ok) throw new Error(`Fixture parse failed: ${r.error}`)
    return r.value
})()

function stateWithLogs(opts: {
    sets: Array<{
        completed: boolean
        weight?: number
        reps?: number
        rpe?: number
        failed?: boolean
        skipped?: boolean
        skipReason?: string
    }>
    startedOffsetSec?: number
}): WorkoutSessionState {
    const start = new Date(Date.now() - (opts.startedOffsetSec ?? 1800) * 1000).toISOString()
    return {
        sessionId: workout.sessionId,
        startedAt: start,
        completedAt: new Date().toISOString(),
        logsByExerciseId: {
            'bench-press': {
                sets: opts.sets.map((s) => ({
                    completed: s.completed,
                    failed: s.failed,
                    skipped: s.skipped,
                    skipReason: s.skipReason,
                    actualWeightKg: s.weight,
                    actualReps: s.reps,
                    actualRpe: s.rpe,
                })),
            },
        },
        _v: 1,
    }
}

// === buildSessionLog =======================================================

{
    const state = stateWithLogs({
        sets: [
            { completed: true, weight: 60, reps: 8, rpe: 7.5 },
            { completed: true, weight: 60, reps: 8, rpe: 8 },
            { completed: true, weight: 60, reps: 7, rpe: 9 },
        ],
    })
    const log = buildSessionLog(workout, state)
    check('buildSessionLog: total sets completed', log.totalSetsCompleted === 3)
    check('buildSessionLog: total sets planned', log.totalSetsPlanned === 3)
    check('buildSessionLog: failed = 0', log.totalSetsFailed === 0)
    check('buildSessionLog: volume = 60×8 + 60×8 + 60×7 = 1380', log.totalVolumeKg === 1380)
    check('buildSessionLog: duration > 0', log.totalDurationSec > 0)
    check('buildSessionLog: best set is 60×8 (first of two ties)', log.exercises[0].bestSet?.actualWeightKg === 60 && log.exercises[0].bestSet?.actualReps === 8)
    check('buildSessionLog: no PR (60×8 = PB)', log.prs.length === 0)
}

// === PR detection ==========================================================

{
    // Heavier weight than PB → weight PR
    const state = stateWithLogs({
        sets: [{ completed: true, weight: 62.5, reps: 6 }],
    })
    const log = buildSessionLog(workout, state)
    const weightPr = log.prs.find((p) => p.kind === 'weight')
    check('PR: heavier weight detected as weight PR', !!weightPr, log.prs)
    check('PR: weight PR carries label', weightPr?.label === '62.5 kg × 6')
    check('PR: weight PR carries previous label', weightPr?.previousLabel === '60 kg × 8')
}

{
    // Same weight, more reps → rep PR
    const state = stateWithLogs({
        sets: [{ completed: true, weight: 60, reps: 10 }],
    })
    const log = buildSessionLog(workout, state)
    const repPr = log.prs.find((p) => p.kind === 'reps')
    check('PR: same weight + more reps = rep PR', !!repPr, log.prs)
}

{
    // 65 × 1 — beats estimated 1RM (was 73)? 65 × 1 = 65 < 73; should NOT trigger.
    const state = stateWithLogs({
        sets: [{ completed: true, weight: 65, reps: 1 }],
    })
    const log = buildSessionLog(workout, state)
    // 65kg > 60kg PB → weight PR
    check('PR: 65×1 beats 60×8 PB on weight', log.prs.some((p) => p.kind === 'weight'))
}

{
    // 55 × 12 — estimated 1RM ~73 vs PB 73. 55*(1+12/30) = 77 → 1RM PR.
    const state = stateWithLogs({
        sets: [{ completed: true, weight: 55, reps: 12 }],
    })
    const log = buildSessionLog(workout, state)
    const est1RMPr = log.prs.find((p) => p.kind === 'estimated_1rm')
    check('PR: 55×12 beats PB est. 1RM', !!est1RMPr, log.prs)
}

{
    // Failed set should not count for PR
    const state = stateWithLogs({
        sets: [{ completed: true, failed: true, weight: 70, reps: 1 }],
    })
    const log = buildSessionLog(workout, state)
    check('PR: failed set ignored', log.prs.length === 0)
}

// === First-time PB (no prior history) =====================================

{
    const noPbWorkoutJson = minimalWorkoutJson.replace(/,"personalBest":\{[^}]+\}/, '')
    const noPbResult = parseWorkoutArtifact(noPbWorkoutJson)
    if (!noPbResult.ok) throw new Error('no-pb fixture failed')
    const exercise = noPbResult.value.groups[0].exercises[0]
    const prs = detectExercisePrs(exercise, [
        { completed: true, actualWeightKg: 50, actualReps: 10 },
    ])
    check('PR: first-time PB labeled "(prima sesiune)"', prs.length === 1 && prs[0].label.includes('prima sesiune'))
}

// === mergeExerciseHistory ==================================================

{
    const log: SessionLog = buildSessionLog(workout, stateWithLogs({
        sets: [{ completed: true, weight: 62.5, reps: 8, rpe: 8 }],
    }))
    const exerciseLog = log.exercises[0]
    const merged = mergeExerciseHistory(null, workout, log, exerciseLog)
    check('merge: new history has 1 session', merged.sessions.length === 1)
    check('merge: new PB is 62.5×8', merged.personalBest?.weightKg === 62.5 && merged.personalBest?.reps === 8)
    check('merge: estimated1RM populated', typeof merged.personalBest?.estimated1RM === 'number')
    check('merge: canonical exercise definition saved once',
        merged.definition?.id === 'bench-press'
        && merged.definition?.equipment?.includes('barbell')
        && merged.definition?.description?.includes('shoulder blades'))
}

// === non-kg resistance + measured duration ================================

{
    const parsed = parseWorkoutArtifact(JSON.stringify({
        sessionId: 'sess-kinesis',
        title: 'Kinesis Test',
        units: 'kg',
        groups: [{
            kind: 'straight',
            exercises: [{
                id: 'kinesis-chest-press',
                name: 'Kinesis Chest Press',
                kind: 'resistance',
                loadUnit: 'level',
                equipment: ['machine', 'cable'],
                muscleGroups: ['chest', 'triceps'],
                personalBest: { load: 6, reps: 10, achievedAt: '2026-05-01' },
                planned: [{ load: 6, reps: 10 }],
            }],
        }],
    }))
    if (!parsed.ok) throw new Error(`resistance fixture failed: ${parsed.error}`)
    const state: WorkoutSessionState = {
        sessionId: parsed.value.sessionId,
        startedAt: new Date(Date.now() - 600_000).toISOString(),
        completedAt: new Date().toISOString(),
        logsByExerciseId: {
            'kinesis-chest-press': {
                sets: [{ completed: true, actualLoad: 7, actualReps: 8 }],
            },
        },
        _v: 1,
    }
    const log = buildSessionLog(parsed.value, state)
    const history = mergeExerciseHistory(null, parsed.value, log, log.exercises[0])
    const md = formatSessionMarkdown(log)
    const sameLoadPrs = detectExercisePrs(parsed.value.groups[0].exercises[0], [
        { completed: true, actualLoad: 6, actualReps: 8 },
        { completed: true, actualLoad: 6, actualReps: 12 },
    ])
    check('resistance: proprietary load does not become kg tonnage', log.totalVolumeKg === 0, log)
    check('resistance: load PR detected', log.prs.some((pr) => pr.kind === 'load'), log.prs)
    check('resistance: highest reps win when load is tied', sameLoadPrs.some((pr) => pr.kind === 'reps'), sameLoadPrs)
    check('resistance: canonical load unit persisted', history.definition?.loadUnit === 'level', history.definition)
    check('resistance: PB persists load and reps', history.personalBest?.load === 7 && history.personalBest?.reps === 8, history.personalBest)
    check('resistance: markdown uses its real unit', md.includes('7 level × 8'), md)
}

{
    check('timer: measured plank duration overrides planned target',
        resolveTimedSetDraftDuration(60, undefined, 37, true) === 37)
    check('timer: saved actual duration remains authoritative',
        resolveTimedSetDraftDuration(60, 42, 37, true) === 42)
    check('timer: unopened set still defaults to planned target',
        resolveTimedSetDraftDuration(60, undefined, 0, false) === 60)
}

{
    const label = {
        exerciseId: 'bench-press',
        exerciseName: 'Bench Press',
        setIndex: 0,
    }
    const rest = createRestState(90, label, 1, 1_000)
    const repaired = normalizePersistedRestState({
        ...rest,
        durationSec: 0,
    })
    const completedButRecent = normalizePersistedRestState({
        ...rest,
        durationSec: 0,
        startedAt: Date.now() - 120_000,
        endsAt: Date.now() - 30_000,
    })
    const baseState: WorkoutSessionState = {
        sessionId: 'timer-signature',
        startedAt: new Date().toISOString(),
        logsByExerciseId: {},
        _v: 1,
    }
    check('rest timer: valid duration builds timestamp-backed state',
        rest?.durationSec === 90 && rest.endsAt === 91_000, rest)
    check('rest timer: explicit zero means no 0:00 timer bar',
        createRestState(0, label, 1, 1_000) === undefined)
    check('rest timer: persisted zero duration repairs from timestamps',
        repaired?.durationSec === 90, repaired)
    check('rest timer: recently completed pause remains resumable as done',
        completedButRecent?.durationSec === 90, completedButRecent)
    check('rest timer: server autosave signature includes active rest',
        sessionContentSignature(baseState) !== sessionContentSignature({ ...baseState, rest }))
}

{
    // Replay-protect: same sessionId merged again replaces, doesn't duplicate.
    const log = buildSessionLog(workout, stateWithLogs({
        sets: [{ completed: true, weight: 60, reps: 8 }],
    }))
    const first = mergeExerciseHistory(null, workout, log, log.exercises[0])
    const second = mergeExerciseHistory(first, workout, log, log.exercises[0])
    check('merge: idempotent for same sessionId', second.sessions.length === 1)
}

{
    // Older PB should not be overwritten by a lower one.
    const heavyLog = buildSessionLog(workout, stateWithLogs({
        sets: [{ completed: true, weight: 70, reps: 5 }],
    }))
    let history: ExerciseHistory | null = null
    history = mergeExerciseHistory(history, workout, heavyLog, heavyLog.exercises[0])

    // Now run a lighter session.
    const lighter = JSON.parse(JSON.stringify(heavyLog)) as SessionLog
    lighter.sessionId = 'sess-light'
    lighter.startedAt = new Date(Date.now() - 86400_000).toISOString()
    lighter.completedAt = new Date(Date.now() - 86400_000 + 1800_000).toISOString()
    lighter.exercises[0].bestSet = { completed: true, actualWeightKg: 50, actualReps: 5 }
    history = mergeExerciseHistory(history, workout, lighter, lighter.exercises[0])
    check('merge: lighter session does NOT lower PB', history.personalBest?.weightKg === 70)
    check('merge: lighter session still added to history', history.sessions.length === 2)
}

// === buildPreviousFromHistory ==============================================

{
    const log = buildSessionLog(workout, stateWithLogs({
        sets: [
            { completed: true, weight: 60, reps: 8, rpe: 8 },
            { completed: true, weight: 60, reps: 7, rpe: 9 },
        ],
    }))
    const history = mergeExerciseHistory(null, workout, log, log.exercises[0])
    const prev = buildPreviousFromHistory(history)
    check('buildPreviousFromHistory: date present', typeof prev?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(prev!.date))
    check('buildPreviousFromHistory: bestSet shape', prev?.bestSet.weightKg === 60 && prev?.bestSet.reps === 8)
    check('buildPreviousFromHistory: allSets present', (prev?.allSets?.length ?? 0) === 2)
}

// === slug + formatting =====================================================

{
    const state = stateWithLogs({ sets: [{ completed: true, weight: 60, reps: 8 }] })
    const slug = buildSessionSlug(workout, state)
    check('slug: matches YYYY-MM-DD-title format', /^\d{4}-\d{2}-\d{2}-test-push$/.test(slug), slug)
}

{
    const log = buildSessionLog(workout, stateWithLogs({
        sets: [{ completed: true, weight: 62.5, reps: 8 }],
    }))
    const line = formatHistoryEntryLine(log)
    check('history line: starts with "- "', line.startsWith('- '))
    check('history line: contains date', /\d{4}-\d{2}-\d{2}/.test(line))
    check('history line: contains title', line.includes('Test Push'))
    check('history line: marks PR when present', log.prs.length > 0 ? line.includes('PR') : true)
}

{
    const log = buildSessionLog(workout, stateWithLogs({
        sets: [
            { completed: true, weight: 60, reps: 8 },
            { completed: false, skipped: true, skipReason: 'aparat ocupat' },
        ],
    }))
    const line = formatHistoryEntryLine(log)
    const md = formatSessionMarkdown(log)
    check('skip: not counted as completed', log.totalSetsCompleted === 1, log.totalSetsCompleted)
    check('skip: history line mentions skipped', line.includes('1 skipped'), line)
    check('skip: markdown mentions skipped', md.includes('1 skipped'), md)
    check('skip: markdown marks the skipped set', md.includes('2. _skipped_'), md)
    check('skip: markdown keeps reason', md.includes('aparat ocupat'), md)
}

{
    const startedAt = new Date(Date.now() - 1800_000).toISOString()
    const state: WorkoutSessionState = {
        sessionId: workout.sessionId,
        startedAt,
        completedAt: new Date().toISOString(),
        logsByExerciseId: {
            'bench-press': {
                sets: [{ completed: true, actualWeightKg: 60, actualReps: 8 }],
            },
            'leg-extension': {
                sets: [{ completed: true, actualWeightKg: 35, actualReps: 12 }],
            },
        },
        addedGroups: [
            {
                kind: 'straight',
                exercises: [
                    {
                        id: 'leg-extension',
                        name: 'Leg Extension',
                        kind: 'weighted',
                        equipment: ['machine'],
                        muscleGroups: ['quads'],
                        planned: [{ kind: 'working', weightKg: 35, reps: 12 }],
                    },
                ],
            },
        ],
        _v: 1,
    }
    const effective = buildEffectiveWorkout(workout, state)
    const log = buildSessionLog(effective, state)
    const md = formatSessionMarkdown(log)
    check('added exercise: counts new planned set', log.totalSetsPlanned === 4, log.totalSetsPlanned)
    check('added exercise: counts new completed set', log.totalSetsCompleted === 2, log.totalSetsCompleted)
    check('added exercise: markdown includes exercise', md.includes('### Leg Extension'), md)
}

{
    const t0 = Date.now() - 1800_000
    const state: WorkoutSessionState = {
        sessionId: workout.sessionId,
        startedAt: new Date(t0).toISOString(),
        completedAt: new Date(t0 + 900_000).toISOString(),
        logsByExerciseId: {
            'bench-press': {
                sets: [
                    {
                        completed: true,
                        actualWeightKg: 60,
                        actualReps: 8,
                        startedAt: new Date(t0 + 10_000).toISOString(),
                        completedAt: new Date(t0 + 40_000).toISOString(),
                    },
                    {
                        completed: true,
                        actualWeightKg: 60,
                        actualReps: 8,
                        startedAt: new Date(t0 + 130_000).toISOString(),
                        completedAt: new Date(t0 + 170_000).toISOString(),
                    },
                ],
            },
        },
        restEvents: [
            {
                exerciseId: 'bench-press',
                exerciseName: 'Bench Press',
                setIndex: 0,
                plannedSec: 90,
                elapsedSec: 85,
                startedAt: new Date(t0 + 40_000).toISOString(),
                endedAt: new Date(t0 + 125_000).toISOString(),
                status: 'replaced',
            },
        ],
        _v: 1,
    }
    const log = buildSessionLog(workout, state)
    const md = formatSessionMarkdown(log)
    const history = mergeExerciseHistory(null, workout, log, log.exercises[0])
    check('timing: rest event saved', log.restEvents.length === 1, log.restEvents)
    check('timing: session set summary count', log.setSummary.timedSetCount === 2, log.setSummary)
    check('timing: session set summary avg', log.setSummary.avgSetSec === 35, log.setSummary)
    check('timing: exercise set summary longest', log.exercises[0].setTiming.longestSetSec === 40, log.exercises[0].setTiming)
    check('timing: avg rest summarized', log.restSummary.avgRestSec === 85, log.restSummary)
    check('timing: avg set duration summarized in history', history.sessions[0].avgSetDurationSec === 35, history.sessions[0])
    check('timing: total set duration summarized in history', history.sessions[0].totalSetDurationSec === 70, history.sessions[0])
    check('timing: timed set count summarized in history', history.sessions[0].timedSetCount === 2, history.sessions[0])
    check('timing: exercise history keeps rest event', history.sessions[0].restEvents?.[0]?.elapsedSec === 85, history.sessions[0])
    check('timing: markdown includes set time', md.includes('Set time avg') && md.includes('2 timed sets'), md)
    check('timing: markdown includes rest avg', md.includes('Rest avg'), md)
    const prompt = summarizeWorkoutForPrompt(workout, state, {
        artifactId: 'artifact-001',
        identifier: 'test-push',
        title: workout.title,
    })
    check('timing: live prompt includes per-set time', prompt.includes('time 0:30') && prompt.includes('time 0:40'), prompt)
    check('timing: live prompt includes avg set time', prompt.includes('avg set time 0:35'), prompt)
}

{
    const log = buildSessionLog(workout, stateWithLogs({
        sets: [
            { completed: true, weight: 60, reps: 8 },
            { completed: true, weight: 60, reps: 8 },
            { completed: true, weight: 60, reps: 7 },
        ],
    }))
    const md = formatSessionMarkdown(log)
    check('markdown: has H1 title', md.startsWith('# Test Push'))
    check('markdown: contains "Sets" line', md.includes('**Sets**'))
    check('markdown: contains "Tonnage" line', md.includes('**Tonnage**'))
    check('markdown: contains Exerciții section', md.includes('## Exerciții'))
    check('markdown: contains bench press recap', md.includes('### Bench Press'))
}

{
    const state = stateWithLogs({
        sets: [{ completed: true, weight: 60, reps: 8 }],
    })
    state.feedback = { rating: 4, notes: 'Good energy, keep bench at same load next time.' }
    const log = buildSessionLog(workout, state)
    const line = formatHistoryEntryLine(log)
    const md = formatSessionMarkdown(log)
    check('feedback: rating preserved in log', log.feedback?.rating === 4, log.feedback)
    check('feedback: notes preserved in log', log.feedback?.notes?.includes('Good energy') === true, log.feedback)
    check('feedback: history line includes rating', line.includes('★ 4/5'), line)
    check('feedback: markdown includes stars', md.includes('★★★★☆ (4/5)'), md)
    check('feedback: markdown includes comments', md.includes('Good energy'), md)
}

// === summary ===============================================================

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
