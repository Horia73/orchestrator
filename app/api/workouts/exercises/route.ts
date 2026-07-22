import { NextResponse } from 'next/server'

import { listExerciseHistoryIds, readExerciseHistory } from '@/lib/workout/storage'
import { runWithCookieProfile } from "@/lib/profiles/server"

/**
 * GET /api/workouts/exercises
 *
 * Returns every exercise with logged history, sorted by most recent session
 * first. Includes the PB and session count so the history page can render
 * a leaderboard / catalogue without N+1 fetches.
 */
export async function GET() {
  return runWithCookieProfile(async () => {
        const ids = listExerciseHistoryIds()
        const exercises = ids.map((id) => {
            const h = readExerciseHistory(id)
            if (!h) return null
            const latest = h.sessions[0]
            return {
                id,
                name: h.name,
                kind: h.kind,
                loadUnit: h.definition?.loadUnit,
                muscleGroups: h.muscleGroups,
                personalBest: h.personalBest,
                sessionCount: h.sessions.length,
                lastSessionDate: latest?.date ?? null,
                updatedAt: h.updatedAt,
            }
        }).filter((e): e is NonNullable<typeof e> => !!e)
        exercises.sort((a, b) => (b.lastSessionDate ?? '').localeCompare(a.lastSessionDate ?? ''))
        return NextResponse.json({ exercises, count: exercises.length })
  })
}
