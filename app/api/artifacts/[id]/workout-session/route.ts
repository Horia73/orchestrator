import { NextResponse } from 'next/server'

import { getArtifactById } from '@/lib/artifacts/store'
import { parseWorkoutArtifact } from '@/lib/workout/parser'
import { runWithRequestProfile } from '@/lib/profiles/server'
import {
    deleteActiveSession,
    readActiveSession,
    writeActiveSession,
} from '@/lib/workout/storage'

/**
 * In-progress workout session autosave, keyed by the stable artifact row id.
 *
 *   GET    → the persisted in-progress session for this artifact (or null).
 *   PUT    → upsert the in-progress session (body: { session }).
 *   DELETE → drop it (called on "Start again" / reset).
 *
 * This is what makes a session resume after a reload, an inbox re-open, or on
 * another device — localStorage only covers the same browser. The finished
 * session is written separately to the workout history on Finish (see
 * `save-workout-session`); this endpoint is the live, pre-finish state.
 *
 * The payload is opaque to the server: it stores and returns the client's
 * `WorkoutSessionState` (plus an `updatedAt` stamp) verbatim, after checking
 * its `sessionId` matches the artifact's so a regenerated plan can't be
 * resumed against stale logs.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

interface StoredSession {
    sessionId?: unknown
}

function loadWorkoutSessionId(artifactId: string): string | null {
    const existing = getArtifactById(artifactId)
    if (!existing || existing.type !== 'application/vnd.ant.workout') return null
    const parsed = parseWorkoutArtifact(existing.content)
    return parsed.ok ? parsed.value.sessionId : null
}

export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    return runWithRequestProfile(request, async () => {
        const { id } = await params
        const sessionId = loadWorkoutSessionId(id)
        if (!sessionId) {
            return NextResponse.json({ session: null }, { headers: NO_STORE })
        }
        const stored = readActiveSession<StoredSession>(id)
        // Ignore state from a previous plan version (different sessionId).
        if (!stored || stored.sessionId !== sessionId) {
            return NextResponse.json({ session: null }, { headers: NO_STORE })
        }
        return NextResponse.json({ session: stored }, { headers: NO_STORE })
    })
}

export async function PUT(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    return runWithRequestProfile(request, async () => {
        const { id } = await params
        const sessionId = loadWorkoutSessionId(id)
        if (!sessionId) {
            return NextResponse.json(
                { error: 'Artifact not found or not a workout' },
                { status: 404, headers: NO_STORE },
            )
        }

        let body: { session?: unknown }
        try {
            body = (await request.json()) as { session?: unknown }
        } catch {
            return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400, headers: NO_STORE })
        }
        const session = body?.session as (StoredSession & Record<string, unknown>) | undefined
        if (!session || typeof session !== 'object' || session.sessionId !== sessionId) {
            return NextResponse.json(
                { error: 'session.sessionId must match the artifact sessionId' },
                { status: 400, headers: NO_STORE },
            )
        }

        writeActiveSession(id, session)
        return NextResponse.json({ ok: true }, { headers: NO_STORE })
    })
}

export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    return runWithRequestProfile(request, async () => {
        const { id } = await params
        deleteActiveSession(id)
        return NextResponse.json({ ok: true }, { headers: NO_STORE })
    })
}
