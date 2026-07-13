import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { SlidingWindowRateLimiter } from '@/lib/api/sliding-window-rate-limit'
import { clearAgentRun, registerAgentRun } from '@/lib/agent-runs'
import { runAppAi, type AppAiFile } from '@/lib/apps/ai'
import { getApp } from '@/lib/apps/store'
import { getActiveProfileId } from '@/lib/profiles/context'
import { runWithRequestProfile } from '@/lib/profiles/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_PROMPT_CHARS = 24_000
const MAX_SYSTEM_PROMPT_CHARS = 12_000
const MAX_FILES = 5
const MAX_FILE_BYTES = 12 * 1024 * 1024
const MAX_TOTAL_BYTES = 24 * 1024 * 1024
const REQUESTS_PER_MINUTE = 12

const rateLimiter = new SlidingWindowRateLimiter(60_000, 1_000)
const globalForAppAi = globalThis as unknown as { __orchestratorActiveAppAi?: Map<string, number> }
const activeByApp = globalForAppAi.__orchestratorActiveAppAi ?? new Map<string, number>()
if (!globalForAppAi.__orchestratorActiveAppAi) globalForAppAi.__orchestratorActiveAppAi = activeByApp

export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    return runWithRequestProfile(request, async () => {
        const guard = guardSensitiveRequest(request)
        if (guard) return guard

        const { id } = await params
        const app = getApp(id)
        if (!app) return NextResponse.json({ error: 'App not found.' }, { status: 404 })

        let form: FormData
        try {
            form = await request.formData()
        } catch {
            return NextResponse.json({ error: 'Expected multipart form data.' }, { status: 400 })
        }
        const prompt = stringField(form.get('prompt')).trim()
        const systemPrompt = stringField(form.get('system_prompt')).trim()
        const responseFormat = stringField(form.get('response_format')) === 'json' ? 'json' : 'text'
        if (!prompt) return NextResponse.json({ error: 'prompt is required.' }, { status: 400 })
        if (prompt.length > MAX_PROMPT_CHARS) {
            return NextResponse.json({ error: `prompt exceeds ${MAX_PROMPT_CHARS} characters.` }, { status: 413 })
        }
        if (systemPrompt.length > MAX_SYSTEM_PROMPT_CHARS) {
            return NextResponse.json({ error: `systemPrompt exceeds ${MAX_SYSTEM_PROMPT_CHARS} characters.` }, { status: 413 })
        }

        const files = form.getAll('files').filter(isFile)
        if (files.length !== form.getAll('files').length || files.length > MAX_FILES) {
            return NextResponse.json({ error: `Attach at most ${MAX_FILES} valid files.` }, { status: 400 })
        }
        let totalBytes = 0
        for (const file of files) {
            totalBytes += file.size
            if (file.size > MAX_FILE_BYTES || totalBytes > MAX_TOTAL_BYTES) {
                return NextResponse.json({ error: 'App AI file limits exceeded (12 MiB each, 24 MiB total).' }, { status: 413 })
            }
            if (!supportedFile(file)) {
                return NextResponse.json({ error: `Unsupported app AI file type: ${file.name || file.type || 'unknown'}. Use a common photo, PDF, or text/data file.` }, { status: 415 })
            }
        }

        const profileId = getActiveProfileId()
        const key = `${profileId}:${app.id}`
        const rate = rateLimiter.check(key, REQUESTS_PER_MINUTE)
        if (!rate.allowed) {
            return NextResponse.json({ error: 'This app is making AI requests too quickly.' }, {
                status: 429,
                headers: { 'Retry-After': String(rate.retryAfterSeconds) },
            })
        }
        if ((activeByApp.get(key) ?? 0) >= 2) {
            return NextResponse.json({ error: 'This app already has two AI requests running.' }, { status: 429 })
        }

        const runId = `app_ai_run_${randomUUID()}`
        if (!registerAgentRun({
            id: runId,
            kind: 'app',
            conversationId: `app:${app.id}`,
            startedAt: Date.now(),
        })) {
            return NextResponse.json({ error: 'An app update is starting; retry after reconnect.' }, { status: 503 })
        }

        activeByApp.set(key, (activeByApp.get(key) ?? 0) + 1)
        let tempDir: string | null = null
        try {
            tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orchestrator-app-ai-'))
            const stored: AppAiFile[] = []
            for (const [index, file] of files.entries()) {
                const name = safeFilename(file.name || `file-${index + 1}`)
                const filePath = path.join(tempDir, `${index + 1}-${name}`)
                await fs.writeFile(filePath, Buffer.from(await file.arrayBuffer()), { flag: 'wx' })
                stored.push({ name, mimeType: normalizedMime(file, name), filePath, size: file.size })
            }
            const result = await runAppAi({
                appId: app.id,
                appTitle: app.title,
                prompt,
                systemPrompt,
                responseFormat,
                files: stored,
                signal: request.signal,
            })
            return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
        } catch (error) {
            return NextResponse.json({ error: error instanceof Error ? error.message : 'Internal app AI request failed.' }, { status: 502 })
        } finally {
            if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
            const next = Math.max(0, (activeByApp.get(key) ?? 1) - 1)
            if (next === 0) activeByApp.delete(key)
            else activeByApp.set(key, next)
            clearAgentRun(runId)
        }
    })
}

function stringField(value: FormDataEntryValue | null): string {
    return typeof value === 'string' ? value : ''
}

function isFile(value: FormDataEntryValue): value is File {
    return typeof value !== 'string' && typeof value.arrayBuffer === 'function'
}

function baseMime(value: string): string {
    return value.split(';')[0].trim().toLowerCase()
}

function normalizedMime(file: File, name: string): string {
    const mime = baseMime(file.type)
    if (mime && mime !== 'application/octet-stream') return mime
    if (/\.pdf$/i.test(name)) return 'application/pdf'
    if (/\.(?:png)$/i.test(name)) return 'image/png'
    if (/\.(?:jpe?g)$/i.test(name)) return 'image/jpeg'
    if (/\.webp$/i.test(name)) return 'image/webp'
    if (/\.json$/i.test(name)) return 'application/json'
    if (/\.(?:txt|md|csv|tsv|xml|ya?ml|log|js|jsx|ts|tsx|py|sql)$/i.test(name)) return 'text/plain'
    return 'application/octet-stream'
}

function supportedFile(file: File): boolean {
    const mime = normalizedMime(file, file.name)
    return ['image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'application/json', 'application/xml', 'application/yaml', 'application/x-yaml'].includes(mime)
        || mime.startsWith('text/')
        || /\.(?:txt|md|csv|tsv|json|xml|ya?ml|log|js|jsx|ts|tsx|py|sql)$/i.test(file.name)
}

function safeFilename(value: string): string {
    const base = path.basename(value).replace(/[\u0000-\u001f\u007f]/g, '').trim()
    return (base || 'file').slice(0, 160)
}
