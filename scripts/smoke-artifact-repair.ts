import { repairArtifactContent, unwrapJsonFence } from '@/lib/artifacts/repair'
import { isStrictArtifactType, validateArtifactContent } from '@/lib/artifacts/validation'

function check(name: string, condition: boolean, detail?: unknown) {
    if (!condition) {
        console.error(`FAIL ${name}`, detail ?? '')
        process.exitCode = 1
        return
    }
    console.log(`ok ${name}`)
}

const WORKOUT = 'application/vnd.ant.workout'

function workout(overrides: { day?: unknown; units?: unknown } = {}): Record<string, unknown> {
    return {
        sessionId: 'smoke-artifact-repair',
        title: 'Smoke repair workout',
        program: { name: 'Full body', day: overrides.day ?? 1 },
        units: overrides.units ?? 'kg',
        groups: [
            {
                kind: 'straight',
                exercises: [
                    {
                        id: 'pushup',
                        name: 'Pushup',
                        kind: 'bodyweight',
                        muscleGroups: ['chest'],
                        planned: [{ reps: 10 }],
                    },
                ],
            },
        ],
    }
}

// The exact failure mode from the real incident: program.day emitted as the
// letter "A" instead of a numeric day index.
const invalidDay = JSON.stringify(workout({ day: 'A' }))
const dayValidation = validateArtifactContent(WORKOUT, invalidDay)
check(
    'fixture reproduces the program.day type error',
    !dayValidation.ok && dayValidation.error.includes('program.day'),
    dayValidation,
)

// ── strict-type membership ─────────────────────────────────────────────────
check('workout is a strict artifact type', isStrictArtifactType(WORKOUT))
check('markdown is not a strict artifact type', !isStrictArtifactType('text/markdown'))

// ── fence unwrapping ────────────────────────────────────────────────────────
check('unwrapJsonFence strips a ```json fence', unwrapJsonFence('```json\n{"a":1}\n```') === '{"a":1}')
check('unwrapJsonFence strips a bare ``` fence', unwrapJsonFence('```\n{"a":1}\n```') === '{"a":1}')
check('unwrapJsonFence leaves unfenced JSON untouched', unwrapJsonFence('{"a":1}') === '{"a":1}')

// ── single-pass repair, with a fenced model reply ───────────────────────────
{
    let calls = 0
    const result = await repairArtifactContent({
        type: WORKOUT,
        content: invalidDay,
        error: dayValidation.ok ? '' : dayValidation.error,
        generate: async () => {
            calls += 1
            // Model returns the corrected body wrapped in a fence (despite being
            // told not to) — the helper must still accept it.
            return '```json\n' + JSON.stringify(workout({ day: 1 })) + '\n```'
        },
    })
    check('single-error repair succeeds', result.ok && result.attempts === 1, result)
    check('single-error repair used exactly one model call', calls === 1, calls)
    if (result.ok) {
        check('repaired content validates', validateArtifactContent(WORKOUT, result.content).ok)
    }
}

// ── iterative repair: parser surfaces one issue at a time ───────────────────
{
    let calls = 0
    const result = await repairArtifactContent({
        type: WORKOUT,
        content: invalidDay,
        error: dayValidation.ok ? '' : dayValidation.error,
        maxAttempts: 3,
        generate: async () => {
            calls += 1
            // First reply only half-fixes it (still an invalid units enum);
            // second reply fixes the rest.
            if (calls === 1) return JSON.stringify(workout({ day: 1, units: 'kilograms' }))
            return JSON.stringify(workout({ day: 1, units: 'kg' }))
        },
    })
    check('iterative repair converges on the second pass', result.ok && result.attempts === 2, result)
    check('iterative repair made two model calls', calls === 2, calls)
}

// ── exhaustion returns the last precise error, not a generic one ────────────
{
    const result = await repairArtifactContent({
        type: WORKOUT,
        content: invalidDay,
        error: dayValidation.ok ? '' : dayValidation.error,
        maxAttempts: 2,
        generate: async () => JSON.stringify(workout({ day: 'B' })), // never fixes it
    })
    check(
        'exhausted repair reports failure with attempts === maxAttempts',
        !result.ok && result.attempts === 2,
        result,
    )
    check(
        'exhausted repair surfaces the concrete validation error',
        !result.ok && result.error.includes('program.day'),
        result,
    )
}

// ── model failure (null output) aborts cleanly ──────────────────────────────
{
    const result = await repairArtifactContent({
        type: WORKOUT,
        content: invalidDay,
        error: 'program.day: boom',
        generate: async () => null,
    })
    check('null model output yields a clean failure', !result.ok && result.attempts === 1, result)
}

console.log('smoke-artifact-repair done')
