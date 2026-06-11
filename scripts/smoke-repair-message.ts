import { repairMessageArtifacts } from '@/lib/artifacts/repair-message'
import { validateArtifactContent } from '@/lib/artifacts/validation'

function check(name: string, condition: boolean, detail?: unknown) {
    if (!condition) {
        console.error(`FAIL ${name}`, detail ?? '')
        process.exitCode = 1
        return
    }
    console.log(`ok ${name}`)
}

const WORKOUT = 'application/vnd.ant.workout'

function workoutJson(overrides: { previous?: unknown; notes?: string } = {}): string {
    return JSON.stringify({
        sessionId: 'smoke-repair-message',
        title: 'Smoke message workout',
        units: 'kg',
        groups: [
            {
                kind: 'straight',
                exercises: [
                    {
                        id: 'pushup',
                        name: 'Pushup',
                        kind: 'bodyweight',
                        muscleGroups: ['chest'],
                        ...(overrides.previous !== undefined ? { previous: overrides.previous } : {}),
                        planned: [{ reps: 10, ...(overrides.notes ? { notes: overrides.notes } : {}) }],
                    },
                ],
            },
        ],
    })
}

function wrap(body: string, identifier = 'smoke-card'): string {
    return [
        'Intro prose before the card.',
        `<artifact identifier="${identifier}" type="${WORKOUT}" title="Smoke" display="fullscreen">`,
        body,
        '</artifact>',
        'Outro prose after the card.',
    ].join('\n')
}

// ── valid artifact: zero model calls, content untouched ─────────────────────
{
    let calls = 0
    const content = wrap(workoutJson())
    const result = await repairMessageArtifacts({
        content,
        surface: 'smoke',
        generate: async () => {
            calls++
            return null
        },
    })
    check('valid artifact costs zero model calls', calls === 0)
    check('valid artifact leaves content untouched', result.content === content)
    check('valid artifact reports nothing', result.repaired.length === 0 && result.failed.length === 0)
}

// ── non-strict types are skipped entirely ───────────────────────────────────
{
    let calls = 0
    const content = [
        '<artifact identifier="notes" type="text/markdown" title="Notes">',
        'not json at all {',
        '</artifact>',
    ].join('\n')
    const result = await repairMessageArtifacts({
        content,
        surface: 'smoke',
        generate: async () => {
            calls++
            return null
        },
    })
    check('permissive types are skipped', calls === 0 && result.failed.length === 0)
}

// ── the real incident: previous without bestSet, repaired and spliced ───────
{
    // The exact failure mode from the 2026-06-10 gym notification: the model
    // invented `previous: { date, sets: [...strings] }` instead of the
    // documented `{ date, bestSet, allSets }`.
    const broken = workoutJson({ previous: { date: '2026-06-06', sets: ['34 kg x 6'] } })
    const fixed = workoutJson({
        previous: { date: '2026-06-06', bestSet: { weightKg: 34, reps: 6 } },
    })
    check(
        'fixture reproduces the previous.bestSet error',
        (() => {
            const v = validateArtifactContent(WORKOUT, broken)
            return !v.ok && v.error.includes('previous.bestSet')
        })(),
    )
    const content = wrap(broken)
    const result = await repairMessageArtifacts({
        content,
        surface: 'smoke',
        generate: async () => fixed,
    })
    check('broken artifact is reported repaired', result.repaired.length === 1 && result.failed.length === 0)
    check('repaired body is spliced into the message', result.content.includes(fixed) && !result.content.includes(broken))
    check('prose around the card survives splicing', result.content.startsWith('Intro prose') && result.content.trimEnd().endsWith('Outro prose after the card.'))
    check(
        'spliced message validates end to end',
        (() => {
            const v = validateArtifactContent(WORKOUT, fixed)
            return v.ok
        })(),
    )
}

// ── `$`-sequences in the repaired JSON must not be expanded ─────────────────
{
    const broken = workoutJson({ previous: { date: '2026-06-06' } })
    const fixed = workoutJson({
        previous: { date: '2026-06-06', bestSet: { reps: 6 } },
        notes: 'cost $& effort $\' tempo',
    })
    const result = await repairMessageArtifacts({
        content: wrap(broken),
        surface: 'smoke',
        generate: async () => fixed,
    })
    check('dollar sequences survive splicing verbatim', result.content.includes(fixed), result.content.slice(0, 400))
}

// ── unrepairable artifact: failure reported, content unchanged ──────────────
{
    const broken = workoutJson({ previous: { date: '2026-06-06', sets: ['34 kg x 6'] } })
    const content = wrap(broken)
    const result = await repairMessageArtifacts({
        content,
        surface: 'smoke',
        maxAttemptsPerArtifact: 2,
        generate: async () => broken, // never fixes it
    })
    check('unrepairable artifact reports failure', result.failed.length === 1 && result.repaired.length === 0)
    check('unrepairable artifact leaves content unchanged', result.content === content)
    check('failure carries the concrete validation error', result.failed[0]?.error.includes('previous.bestSet') ?? false, result.failed)
}

// ── multiple artifacts: only the broken one is repaired ─────────────────────
{
    const broken = workoutJson({ previous: { date: '2026-06-06', sets: ['x'] } })
    const fixed = workoutJson({ previous: { date: '2026-06-06', bestSet: { reps: 6 } } })
    const valid = workoutJson()
    const content = `${wrap(valid, 'good-card')}\n\n${wrap(broken, 'bad-card')}`
    let calls = 0
    const result = await repairMessageArtifacts({
        content,
        surface: 'smoke',
        generate: async () => {
            calls++
            return fixed
        },
    })
    check('only the broken artifact hits the model', calls === 1)
    check('valid sibling stays untouched', result.content.includes(valid))
    check('broken sibling is repaired', result.content.includes(fixed) && result.repaired[0]?.identifier === 'bad-card')
}

console.log('smoke-repair-message done')
