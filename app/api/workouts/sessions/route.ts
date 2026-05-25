import { NextResponse } from 'next/server'

import { listRecentSessionSlugs, readSessionLog } from '@/lib/workout/storage'

/**
 * GET /api/workouts/sessions?limit=20
 *
 * Returns recent workout sessions, newest first. Used by the /workouts
 * history page. The payload mirrors `SessionLog` but trimmed to header
 * fields + per-exercise summary — full per-set arrays come from
 * /sessions/[slug].
 */
export async function GET(request: Request) {
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
        }
    }).filter((s): s is NonNullable<typeof s> => !!s)

    return NextResponse.json({ sessions, count: sessions.length })
}
