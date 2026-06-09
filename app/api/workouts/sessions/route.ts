import { NextResponse } from 'next/server'

import { listRecentSessionSlugs, readSessionLog } from '@/lib/workout/storage'
import type { SessionLog } from '@/lib/workout/save-session'
import { runWithRequestProfile } from "@/lib/profiles/server"

/**
 * GET /api/workouts/sessions?limit=20
 *
 * Returns recent workout sessions, newest first. Used by the /workouts
 * history page. The payload mirrors `SessionLog` but trimmed to header
 * fields + per-exercise summary — full per-set arrays come from
 * /sessions/[slug].
 */
export async function GET(request: Request) {
  return runWithRequestProfile(request, async () => {
        const url = new URL(request.url)
        const limitParam = url.searchParams.get('limit')
        const limit = Math.max(1, Math.min(50, parseInt(limitParam ?? '20', 10) || 20))

        const slugs = listRecentSessionSlugs(limit)
        const sessions = slugs.map((slug) => {
            const log = readSessionLog(slug)
            if (!log) return null
            return {
                slug,
                sessionId: log.sessionId,
                title: log.title,
                subtitle: log.subtitle,
                program: log.program,
                difficulty: log.difficulty,
                units: log.units,
                startedAt: log.startedAt,
                completedAt: log.completedAt,
                totalDurationSec: log.totalDurationSec,
                totalSetsPlanned: log.totalSetsPlanned,
                totalSetsCompleted: log.totalSetsCompleted,
                totalSetsFailed: log.totalSetsFailed,
                totalVolumeKg: log.totalVolumeKg,
                prCount: log.prs.length,
                prs: log.prs,
                exerciseCount: log.exercises.length,
                exerciseNames: log.exercises.map((e) => e.name),
                // `restSummary` only exists on sessions logged after the rest-
                // analytics change; older files omit it (handled client-side).
                restSummary: log.restSummary,
                // Completed sets attributed to each targeted muscle group, so
                // the Library can render a weekly muscle-balance breakdown
                // without re-fetching every full session.
                muscleBreakdown: buildMuscleBreakdown(log),
            }
        }).filter((s): s is NonNullable<typeof s> => !!s)

        return NextResponse.json({ sessions, count: sessions.length })
  })
}

/**
 * Completed (non-failed, non-skipped) sets per muscle group for one session.
 * A set counts toward every muscle group the exercise targets — the standard
 * "weekly sets per muscle" convention — so compound lifts feed multiple groups.
 */
function buildMuscleBreakdown(log: SessionLog): Array<{ group: string; sets: number }> {
    const byGroup = new Map<string, number>()
    for (const exercise of log.exercises) {
        if (exercise.skipped) continue
        const sets = exercise.loggedSets.filter((s) => s.completed && !s.failed && !s.skipped).length
        if (sets <= 0) continue
        for (const group of exercise.muscleGroups ?? []) {
            byGroup.set(group, (byGroup.get(group) ?? 0) + sets)
        }
    }
    return Array.from(byGroup, ([group, sets]) => ({ group, sets }))
}
