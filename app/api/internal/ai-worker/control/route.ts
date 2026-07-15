import { timingSafeEqual } from 'crypto'
import { NextResponse } from 'next/server'

import { listAgentRuns } from '@/lib/agent-runs'
import {
    blockAiRunAdmission,
    getAiRunAdmissionBlock,
    unblockAiRunAdmission,
} from '@/lib/ai/run-admission'
import { isDurableAiWorkerProcess } from '@/lib/ai/durable-worker'
import { listAllActiveChatStreams } from '@/lib/chat-streams'

const ROTATION_OWNER = 'durable-ai-worker-rotation'

export async function GET(request: Request) {
    const guard = guardWorkerControl(request)
    if (guard) return guard
    return NextResponse.json(workerStatus(), {
        headers: { 'Cache-Control': 'no-store' },
    })
}

export async function POST(request: Request) {
    const guard = guardWorkerControl(request)
    if (guard) return guard

    let body: { action?: unknown }
    try {
        body = await request.json()
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
    }

    if (body.action === 'drain') {
        blockAiRunAdmission(
            ROTATION_OWNER,
            'The durable AI worker is draining before a version rotation.',
        )
        return NextResponse.json(workerStatus(), {
            headers: { 'Cache-Control': 'no-store' },
        })
    }
    if (body.action === 'resume') {
        unblockAiRunAdmission(ROTATION_OWNER)
        return NextResponse.json(workerStatus(), {
            headers: { 'Cache-Control': 'no-store' },
        })
    }

    return NextResponse.json({ error: 'Unsupported worker control action.' }, { status: 400 })
}

function workerStatus() {
    const chatStreams = listAllActiveChatStreams()
    const agentRuns = listAgentRuns()
    return {
        ok: true,
        role: 'ai-worker',
        protocolVersion: 1,
        draining: Boolean(getAiRunAdmissionBlock()),
        admissionBlock: getAiRunAdmissionBlock(),
        activeRunCount: chatStreams.length + agentRuns.length,
        chatStreams,
        agentRuns,
        buildCommit: process.env.ORCHESTRATOR_BUILD_COMMIT || null,
        checkedAt: Date.now(),
    }
}

function guardWorkerControl(request: Request): NextResponse | null {
    if (!isDurableAiWorkerProcess()) {
        return NextResponse.json({ error: 'Not found.' }, { status: 404 })
    }

    const expected = (
        process.env.ORCHESTRATOR_DOCKER_UPDATE_TOKEN
        || process.env.ORCHESTRATOR_HOST_UPDATE_TOKEN
        || ''
    ).trim()
    const auth = request.headers.get('authorization')?.trim() || ''
    const candidate = auth.toLowerCase().startsWith('bearer ')
        ? auth.slice(7).trim()
        : request.headers.get('x-orchestrator-host-bridge-token')?.trim() || ''
    if (!expected || !constantTimeEqual(candidate, expected)) {
        return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
    }
    return null
}

function constantTimeEqual(left: string, right: string): boolean {
    const a = Buffer.from(left)
    const b = Buffer.from(right)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
}
