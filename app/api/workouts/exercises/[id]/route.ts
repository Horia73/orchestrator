import { NextResponse } from 'next/server'

import { readExerciseHistory } from '@/lib/workout/storage'
import { estimated1RM } from '@/lib/workout/one-rep-max'
import { runWithRequestProfile } from "@/lib/profiles/server"

/**
 * GET /api/workouts/exercises/:id
 *
 * Returns the full per-exercise rollup: PB, every recorded session with all
 * sets, an enriched per-session `estimated1RM` for the best set so the
 * page can plot a 1RM trend line.
 */
export async function GET(
    _request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
  return runWithRequestProfile(_request, async () => {
        const { id } = await params
        if (!/^[a-z0-9][a-z0-9_-]*$/.test(id)) {
            return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
        }
        const history = readExerciseHistory(id)
        if (!history) {
            return NextResponse.json({ error: 'Exercise not found' }, { status: 404 })
        }
        const sessions = history.sessions.map((s) => {
            const est1RM = s.bestSet.actualWeightKg !== undefined && s.bestSet.actualReps !== undefined
                ? estimated1RM(s.bestSet.actualWeightKg, s.bestSet.actualReps)
                : null
            return { ...s, estimated1RM: est1RM }
        })
        return NextResponse.json({
            ...history,
            sessions,
        })
  })
}
