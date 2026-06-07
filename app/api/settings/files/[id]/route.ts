import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { getWorkspaceFile, writeWorkspaceFile } from '@/lib/settings/workspace-files'
import { runWithRequestProfile } from "@/lib/profiles/server"

export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
  return runWithRequestProfile(request, async () => {
        const guard = guardSensitiveRequest(request)
        if (guard) return guard

        const { id } = await params
        try {
            const file = getWorkspaceFile(id)
            if (!file) return NextResponse.json({ error: 'File not found' }, { status: 404 })
            return NextResponse.json(
                { file },
                { headers: { 'Cache-Control': 'no-store' } }
            )
        } catch (error) {
            return NextResponse.json(
                { error: error instanceof Error ? error.message : 'Failed to read file' },
                { status: 500 }
            )
        }
  })
}

export async function PUT(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
  return runWithRequestProfile(request, async () => {
        const guard = guardSensitiveRequest(request)
        if (guard) return guard

        const { id } = await params
        let body: unknown
        try {
            body = await request.json()
        } catch {
            return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
        }

        const content = body && typeof body === 'object' && 'content' in body
            ? (body as { content?: unknown }).content
            : undefined
        if (typeof content !== 'string') {
            return NextResponse.json({ error: 'Missing string content' }, { status: 400 })
        }

        try {
            const file = writeWorkspaceFile(id, content)
            if (!file) return NextResponse.json({ error: 'File not found' }, { status: 404 })
            return NextResponse.json(
                { success: true, file },
                { headers: { 'Cache-Control': 'no-store' } }
            )
        } catch (error) {
            return NextResponse.json(
                { error: error instanceof Error ? error.message : 'Failed to save file' },
                { status: 400 }
            )
        }
  })
}
