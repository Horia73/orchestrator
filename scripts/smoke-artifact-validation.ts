import { validateArtifactContent } from '@/lib/artifacts/validation'

function check(name: string, condition: boolean, detail?: unknown) {
    if (!condition) {
        console.error(`FAIL ${name}`, detail ?? '')
        process.exitCode = 1
        return
    }
    console.log(`ok ${name}`)
}

const validWorkout = JSON.stringify({
    sessionId: 'smoke-artifact-validation',
    title: 'Smoke workout',
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
                    planned: [{ reps: 10 }],
                },
            ],
        },
    ],
})

const legacyWorkout = JSON.stringify({
    title: 'Legacy workout',
    durationMinutes: 45,
    exercises: [
        {
            id: 'pushup',
            name: 'Pushup',
            sets: [{ reps: 10 }],
        },
    ],
})

const valid = validateArtifactContent('application/vnd.ant.workout', validWorkout)
check('strict workout artifact validates', valid.ok, valid)

const invalid = validateArtifactContent('application/vnd.ant.workout', legacyWorkout)
check('legacy workout artifact is rejected', !invalid.ok && invalid.error.includes('sessionId'), invalid)

const markdown = validateArtifactContent('text/markdown', legacyWorkout)
check('non-strict artifact types remain permissive', markdown.ok, markdown)
