import { NextResponse } from 'next/server'

import { getArtifactById, updateArtifactContentById } from '@/lib/artifacts/store'
import { parseQuestionArtifact } from '@/lib/questions/schema'
import { runWithRequestProfile } from '@/lib/profiles/server'

/**
 * POST /api/artifacts/:id/answer
 *
 * Records the user's answer onto a `vnd.ant.question` card. Merges an
 * `answered` block (selected labels + optional free text + timestamp) into the
 * artifact body IN PLACE (same id/version) so a reload renders the locked,
 * resolved card instead of a fresh interactive one — and so the card cannot be
 * answered twice.
 *
 * The chosen value is ALSO posted as the user's next chat message by the
 * client (that is what continues the agent turn). This route only persists the
 * card state; it starts no model turn. Returns the updated ArtifactRow, which
 * the client feeds into `useConversationArtifacts` to re-render in place.
 */
export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    return runWithRequestProfile(request, async () => {
        const { id } = await params

        const existing = getArtifactById(id)
        if (!existing) {
            return NextResponse.json({ error: 'Artifact not found' }, { status: 404 })
        }
        if (existing.type !== 'application/vnd.ant.question') {
            return NextResponse.json(
                { error: `Answer only supported for question artifacts (got "${existing.type}")` },
                { status: 400 },
            )
        }

        const parsed = parseQuestionArtifact(existing.content)
        if (!parsed.ok) {
            return NextResponse.json(
                { error: `Stored question artifact did not parse: ${parsed.error}` },
                { status: 500 },
            )
        }
        if (parsed.value.answered) {
            // Already answered — idempotent no-op so a double-tap or a late
            // retry after a reload can't overwrite the first answer.
            return NextResponse.json(existing)
        }

        let body: unknown
        try {
            body = await request.json()
        } catch {
            body = {}
        }
        const payload = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
        const rawSelected = Array.isArray(payload.selected) ? payload.selected : []
        const validLabels = new Set(parsed.value.options.map((o) => o.label))
        const selected = rawSelected
            .filter((s): s is string => typeof s === 'string')
            .map((s) => s.trim())
            .filter((s) => validLabels.has(s))
        const other = typeof payload.other === 'string' && payload.other.trim()
            ? payload.other.trim().slice(0, 2000)
            : undefined

        if (selected.length === 0 && !other) {
            return NextResponse.json(
                { error: 'Answer requires at least one selected option label or non-empty `other` text.' },
                { status: 400 },
            )
        }

        const nextBody = JSON.stringify({
            ...parsed.value,
            answered: {
                selected,
                ...(other ? { other } : {}),
                answeredAt: new Date().toISOString(),
            },
        })

        const row = updateArtifactContentById(id, nextBody)
        if (!row) {
            return NextResponse.json({ error: 'Artifact vanished during update' }, { status: 404 })
        }
        return NextResponse.json(row)
    })
}
