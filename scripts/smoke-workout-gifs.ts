/**
 * Smoke test for ExerciseDB OSS GIF workout demos.
 *
 * Run: npx tsx scripts/smoke-workout-gifs.ts
 */

import {
    __clearExerciseGifCacheForTesting,
    parseExerciseDbGifEntries,
    resolveExerciseGif,
} from '@/lib/workout/exercise-gif-search'
import { searchWorkoutImages } from '@/lib/workout/image-search'

let failures = 0
function check(name: string, condition: unknown, detail?: unknown) {
    if (condition) {
        console.log(`PASS ${name}`)
        return
    }
    failures++
    console.error(`FAIL ${name}`, detail ?? '')
}

async function withMockFetch<T>(
    handler: (input: string | URL | Request) => Response | Promise<Response>,
    run: () => Promise<T>,
): Promise<T> {
    const original = globalThis.fetch
    globalThis.fetch = ((input: string | URL | Request) => handler(input)) as typeof fetch
    try {
        return await run()
    } finally {
        globalThis.fetch = original
    }
}

async function main() {
    const parsed = parseExerciseDbGifEntries({
        success: true,
        data: [
            {
                exerciseId: 'EIeI8Vf',
                name: 'barbell bench press',
                gifUrl: 'https://static.exercisedb.dev/media/EIeI8Vf.gif',
            },
            {
                exerciseId: 'bad',
                name: 'bad host',
                gifUrl: 'https://example.com/bad.gif',
            },
            {
                exerciseId: 'also-bad',
                name: 'not a gif',
                gifUrl: 'https://static.exercisedb.dev/media/not-a-gif.jpg',
            },
        ],
    })
    check('parse: keeps only ExerciseDB GIF URLs', parsed.length === 1, parsed)
    check('parse: preserves exercise id', parsed[0]?.exerciseId === 'EIeI8Vf', parsed[0])

    __clearExerciseGifCacheForTesting()
    let requestedSearch = ''
    await withMockFetch(
        async (input) => {
            const url = new URL(String(input))
            requestedSearch = url.searchParams.get('search') ?? ''
            return Response.json({
                success: true,
                data: [
                    {
                        exerciseId: 'SpYC0Kp',
                        name: 'dumbbell bench press',
                        gifUrl: 'https://static.exercisedb.dev/media/SpYC0Kp.gif',
                    },
                    {
                        exerciseId: 'EIeI8Vf',
                        name: 'barbell bench press',
                        gifUrl: 'https://static.exercisedb.dev/media/EIeI8Vf.gif',
                    },
                ],
            })
        },
        async () => {
            const image = await resolveExerciseGif({
                id: 'bench-press',
                name: 'Bench Press',
                equipment: ['barbell', 'bench'],
                muscles: ['chest', 'triceps'],
            })
            check('resolve: uses equipment in search query', requestedSearch === 'barbell Bench Press', requestedSearch)
            check('resolve: chooses matching equipment GIF', image?.url.endsWith('/EIeI8Vf.gif'), image)
            check('resolve: returns gif mime', image?.mime === 'image/gif', image)
        },
    )

    __clearExerciseGifCacheForTesting()
    await withMockFetch(
        async () => Response.json({
            success: true,
            data: [
                {
                    exerciseId: 'EIeI8Vf',
                    name: 'barbell bench press',
                    gifUrl: 'https://static.exercisedb.dev/media/EIeI8Vf.gif',
                },
            ],
        }),
        async () => {
            const images = await searchWorkoutImages('barbell bench press', { limit: 1 })
            check('searchWorkoutImages: prefers ExerciseDB GIFs', images[0]?.mime === 'image/gif', images)
            check('searchWorkoutImages: respects limit', images.length === 1, images)
        },
    )

    if (failures > 0) {
        process.exitCode = 1
    }
}

main().catch((err) => {
    console.error(err)
    process.exitCode = 1
})
