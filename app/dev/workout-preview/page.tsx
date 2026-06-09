"use client"

import * as React from "react"

import { WorkoutRenderer } from "@/components/artifacts/renderers/workout-renderer"

/**
 * Dev-only preview surface for the workout artifact renderer. Lets us
 * iterate on the UI without spinning up a full chat conversation. Edit
 * the SAMPLE_WORKOUT constant below to test new shapes.
 *
 * Not linked from anywhere in the app; navigate to /dev/workout-preview
 * directly.
 */
export default function WorkoutPreviewPage() {
    const [variant, setVariant] = React.useState<keyof typeof SAMPLES>('full')

    return (
        <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
            <header className="flex flex-wrap items-center gap-2 border-b border-border/40 pb-3">
                <h1 className="text-xl font-semibold tracking-tight">Workout renderer preview</h1>
                <span className="text-xs text-muted-foreground">Phase 1 · static</span>
                <div className="ml-auto inline-flex rounded-md border border-border/60 bg-background p-0.5 text-xs">
                    {(Object.keys(SAMPLES) as Array<keyof typeof SAMPLES>).map((k) => (
                        <button
                            key={k}
                            onClick={() => setVariant(k)}
                            className={`rounded px-2.5 py-1 transition-colors ${variant === k ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/50'}`}
                        >
                            {k}
                        </button>
                    ))}
                </div>
            </header>
            <WorkoutRenderer
                source={JSON.stringify(SAMPLES[variant])}
                title={SAMPLES[variant].title}
            />
            <details className="mt-6 rounded-md border border-border/40 bg-muted/20 p-3 text-xs">
                <summary className="cursor-pointer font-medium text-muted-foreground">Source JSON</summary>
                <pre className="mt-2 overflow-auto text-[11px]">{JSON.stringify(SAMPLES[variant], null, 2)}</pre>
            </details>
        </div>
    )
}

const SAMPLES = {
    full: {
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
            items: ['5 min bike Z2', '2 sets light bench (20kg × 10)', 'Band pull-aparts × 15'],
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
                        description: 'Setează banca sub rack astfel încât bara să fie deasupra ochilor. Omoplații rămân retrași, picioarele împing în podea, iar bara coboară controlat spre partea de jos a pieptului.',
                        imageQuery: 'barbell bench press exercise setup',
                        alternatives: ['Dumbbell bench press · 3×8-10', 'Machine chest press · 3×10', 'Push-ups weighted or banded · 3×AMRAP'],
                        videoUrl: 'https://www.youtube.com/watch?v=4Y2ZdHCOXok',
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
                            { kind: 'warmup', weightKg: 50, reps: 3 },
                            { kind: 'top_set', weightKg: 62.5, reps: [6, 8], rpe: 8, restSec: 180 },
                            { weightKg: 60, reps: [6, 8], rpe: 8 },
                            { weightKg: 60, reps: [6, 8], rpe: 8 },
                            { kind: 'amrap', weightKg: 55, reps: 1, notes: 'until failure — track for next week' },
                        ],
                    },
                ],
            },
            {
                kind: 'superset',
                label: 'Superset A',
                restBetweenSec: 90,
                exercises: [
                    {
                        id: 'incline-db-press',
                        name: 'Incline DB Press',
                        kind: 'weighted',
                        equipment: ['dumbbell', 'bench'],
                        muscleGroups: ['chest', 'front_delt'],
                        previous: { date: '2026-05-21', bestSet: { weightKg: 22.5, reps: 10 } },
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
                        equipment: ['cable'],
                        muscleGroups: ['chest'],
                        description: 'Ajustează scripetele la nivelul pieptului sau ușor mai jos. Fă un pas în față, coatele rămân moi, iar mâinile se întâlnesc în fața sternului fără să pierzi tensiunea din piept.',
                        imageQuery: 'cable fly machine exercise setup',
                        planned: [
                            { weightKg: 15, reps: 15 },
                            { weightKg: 15, reps: 15 },
                            { weightKg: 15, reps: 15 },
                        ],
                    },
                ],
            },
            {
                kind: 'circuit',
                label: 'Finisher',
                rounds: 3,
                restBetweenSec: 60,
                exercises: [
                    {
                        id: 'dips',
                        name: 'Dips',
                        kind: 'bodyweight',
                        equipment: ['bodyweight'],
                        muscleGroups: ['chest', 'triceps'],
                        planned: [{ reps: 12 }],
                    },
                    {
                        id: 'tricep-pushdown',
                        name: 'Tricep Pushdown',
                        kind: 'weighted',
                        equipment: ['cable'],
                        muscleGroups: ['triceps'],
                        planned: [{ weightKg: 25, reps: 12 }],
                    },
                    {
                        id: 'plank',
                        name: 'Plank',
                        kind: 'hold',
                        equipment: ['mat'],
                        muscleGroups: ['abs', 'lower_back'],
                        planned: [{ durationSec: 45 }],
                    },
                ],
            },
            {
                kind: 'straight',
                exercises: [
                    {
                        id: 'tabata-burpees',
                        name: 'Tabata Burpees',
                        kind: 'interval',
                        equipment: ['bodyweight'],
                        muscleGroups: ['full_body', 'cardio'],
                        planned: [{ rounds: 8, workSec: 20, intraRestSec: 10 }],
                    },
                ],
            },
        ],
        cooldown: { items: ['Stretching 5 min', 'Foam roll IT band'], estimatedMinutes: 8 },
        generatedAt: '2026-05-25T10:00:00Z',
        notes: 'Deload next week — drop intensity to 70%.',
    },
    minimal: {
        sessionId: 'sess-min',
        title: 'Quick Push',
        units: 'kg',
        groups: [
            {
                kind: 'straight',
                exercises: [
                    {
                        id: 'bench-press',
                        name: 'Bench Press',
                        kind: 'weighted',
                        muscleGroups: ['chest'],
                        planned: [
                            { weightKg: 60, reps: 8 },
                            { weightKg: 60, reps: 8 },
                            { weightKg: 60, reps: 8 },
                        ],
                    },
                ],
            },
        ],
    },
    bodyweight: {
        sessionId: 'sess-bw',
        title: 'Pull Day (Home)',
        units: 'kg',
        groups: [
            {
                kind: 'straight',
                exercises: [
                    {
                        id: 'pullups',
                        name: 'Pull-ups',
                        kind: 'bodyweight',
                        equipment: ['pullup_bar'],
                        muscleGroups: ['lats', 'biceps'],
                        planned: [{ reps: [6, 10] }, { reps: [6, 10] }, { reps: [6, 10] }, { reps: 1, kind: 'amrap' }],
                    },
                    {
                        id: 'rows',
                        name: 'Inverted Rows',
                        kind: 'bodyweight',
                        equipment: ['rings'],
                        muscleGroups: ['mid_back', 'biceps'],
                        planned: [{ reps: 12 }, { reps: 12 }, { reps: 12 }],
                    },
                ],
            },
        ],
    },
    cardio: {
        sessionId: 'sess-cardio',
        title: 'Sunday Long Run',
        units: 'kg',
        difficulty: 'mediu',
        groups: [
            {
                kind: 'straight',
                exercises: [
                    {
                        id: 'long-run',
                        name: 'Long Run',
                        kind: 'cardio_dist',
                        equipment: ['treadmill'],
                        muscleGroups: ['cardio'],
                        planned: [{ distanceM: 12000, targetMetric: 'Z2 HR · 5:30/km' }],
                    },
                ],
            },
        ],
    },
    error: {
        // Deliberately malformed — exercises an error state.
        sessionId: 'sess-broken',
        title: 'Broken',
        units: 'kg',
        groups: [
            {
                kind: 'straight',
                exercises: [
                    {
                        id: 'bench-press',
                        name: 'Bench Press',
                        kind: 'weighted',
                        muscleGroups: ['chest'],
                        planned: [{ reps: 8 }], // missing weightKg
                    },
                ],
            },
        ],
    },
} as const
