import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'

import { z } from 'zod'

import { researcher } from '@/lib/ai/agents/researcher'
import { runTextSubAgent } from '@/lib/ai/agents/runner'
import type { AgentRunEvent, ToolExecutionContext } from '@/lib/ai/agents/types'
import { buildModelMetadataResearchPrompt } from '@/lib/ai/prompts/model-metadata-research'
import { getEffectiveAgentSettings } from '@/lib/config'
import {
    CapabilitySchema,
    CuratedModelEntrySchema,
    IntelligenceTierSchema,
    ModelCustomMetadataSchema,
    ModelDataFieldSchema,
    ModelFeatureSchema,
    ModelKindSchema,
    ModelPricingSchema,
    ResearchSourceSchema,
    ThinkingLevelSchema,
    curatedKey,
    type CuratedModelEntry,
    type EffectiveModelEntry,
    type ModelDataField,
} from '@/lib/models/schema'
import { getEffectiveRegistry, patchCuratedModel } from '@/lib/models/registry'
import { getProviderReadiness, getProviderReadinessMap } from '@/lib/provider-readiness'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MODEL_RESEARCH_MAX_ATTEMPTS = 2
const MODEL_RESEARCH_ATTEMPT_TIMEOUT_MS = 10 * 60 * 1000
const MODEL_RESEARCH_CONCURRENCY = 6
const MODEL_RESEARCH_EVENT_LIMIT = 500

const ResearchFieldsSchema = z.object({
    pricing: ModelPricingSchema.nullable().optional(),
    pricingNotes: z.string().optional(),
    contextWindow: z.number().int().positive().optional(),
    maxOutputTokens: z.number().int().positive().optional(),
    knowledgeCutoff: z.string().min(1).optional(),
    thinkingLevels: z.array(ThinkingLevelSchema).optional(),
    defaultThinkingLevel: ThinkingLevelSchema.optional(),
    capabilities: z.array(CapabilitySchema).optional(),
    features: z.array(ModelFeatureSchema).optional(),
    customMetadata: z.array(ModelCustomMetadataSchema).optional(),
    intelligenceTier: IntelligenceTierSchema.optional(),
    kinds: z.array(ModelKindSchema).optional(),
    notes: z.string().optional(),
})

const UnresolvedFieldSchema = z.object({
    field: ModelDataFieldSchema,
    reason: z.string().optional(),
})

const ResearchResultSchema = z.object({
    status: z.enum(['found', 'insufficient']),
    summary: z.string().optional(),
    fields: ResearchFieldsSchema.optional(),
    sources: z.array(ResearchSourceSchema).optional(),
    unresolved: z.array(UnresolvedFieldSchema).optional(),
})

type UnresolvedField = z.infer<typeof UnresolvedFieldSchema>
type ResearchModelStatus = 'updated' | 'unchanged' | 'incomplete' | 'failed'

type ResearchEventBase = { at?: number }

type ResearchEvent = ResearchEventBase & (
    | { type: 'ready'; runId: string; total: number; concurrency: number }
    | { type: 'model_start'; key: string; providerId: string; modelId: string; name: string; index: number; total: number; missing: string[] }
    | { type: 'agent_event'; key: string; event: AgentRunEvent }
    | { type: 'model_retry'; key: string; attempt: number; maxAttempts: number; reason: string }
    | { type: 'model_result'; key: string; status: ResearchModelStatus; summary?: string; error?: string; remainingMissing?: ModelDataField[]; unresolved?: UnresolvedField[]; model?: EffectiveModelEntry }
    | { type: 'done'; runId: string; total: number; updated: number; incomplete: number; failed: number }
    | { type: 'stopped'; runId: string; message: string }
    | { type: 'error'; runId: string; message: string }
)

type ResearchTarget = { providerId: string; modelId: string; model: EffectiveModelEntry }

type ActiveResearchJob = {
    id: string
    controller: AbortController
    startedAt: number
    endedAt?: number
    concurrency: number
    status: 'running' | 'done' | 'stopped' | 'error'
    events: ResearchEvent[]
    subscribers: Set<(event: ResearchEvent) => void>
    promise: Promise<void>
}

type ResearchGlobals = typeof globalThis & {
    __orchestratorModelResearchJob?: ActiveResearchJob
    __orchestratorModelResearchLastJob?: ActiveResearchJob
}

function researchGlobals(): ResearchGlobals {
    return globalThis as ResearchGlobals
}

// ---------------------------------------------------------------------------
// Durable snapshot — the active job lives on a module global, which does not
// survive a server restart or HMR reload. We mirror the run's structural
// events (everything except the high-volume agent transcript) to disk so a
// browser refresh rehydrates the real run state instead of stale localStorage.
// ---------------------------------------------------------------------------

const RESEARCH_SNAPSHOT_PATH = path.join(process.cwd(), '.orchestrator', 'workspace', 'model-research-last.json')

type ResearchJobSnapshot = {
    runId: string
    status: ActiveResearchJob['status']
    startedAt: number
    endedAt: number | null
    concurrency: number
    events: ResearchEvent[]
}

function persistJobSnapshot(job: ActiveResearchJob): void {
    try {
        const dir = path.dirname(RESEARCH_SNAPSHOT_PATH)
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        const snapshot: ResearchJobSnapshot = {
            runId: job.id,
            status: job.status,
            startedAt: job.startedAt,
            endedAt: job.endedAt ?? null,
            concurrency: job.concurrency,
            // Drop the agent transcript — it's large, live-only, and not needed
            // to reconstruct the run list / counter after a refresh.
            events: job.events.filter(event => event.type !== 'agent_event'),
        }
        const tmp = `${RESEARCH_SNAPSHOT_PATH}.tmp-${randomUUID()}`
        fs.writeFileSync(tmp, JSON.stringify(snapshot), { mode: 0o600 })
        fs.renameSync(tmp, RESEARCH_SNAPSHOT_PATH)
    } catch {
        // Best-effort: the live in-memory job remains the source of truth.
    }
}

function readPersistedJobSnapshot(): ResearchJobSnapshot | null {
    try {
        if (!fs.existsSync(RESEARCH_SNAPSHOT_PATH)) return null
        const parsed = JSON.parse(fs.readFileSync(RESEARCH_SNAPSHOT_PATH, 'utf-8')) as ResearchJobSnapshot
        if (!parsed || !Array.isArray(parsed.events)) return null
        if (containsLegacyCodexMcpTransportError(parsed.events)) {
            clearPersistedJobSnapshot()
            return null
        }
        return parsed
    } catch {
        return null
    }
}

function clearPersistedJobSnapshot(): void {
    try {
        if (fs.existsSync(RESEARCH_SNAPSHOT_PATH)) fs.unlinkSync(RESEARCH_SNAPSHOT_PATH)
    } catch {
        // Best-effort: clearing the UI preview should not fail the request.
    }
}

function idleResearchResponse(): Response {
    return Response.json({
        running: false,
        runId: null,
        status: 'idle',
        startedAt: null,
        endedAt: null,
        concurrency: MODEL_RESEARCH_CONCURRENCY,
        events: [],
    }, { headers: { 'Cache-Control': 'no-store' } })
}

function activeResearchJob(): ActiveResearchJob | undefined {
    const job = researchGlobals().__orchestratorModelResearchJob
    return job?.status === 'running' ? job : undefined
}

function latestResearchJob(): ActiveResearchJob | undefined {
    return activeResearchJob() ?? researchGlobals().__orchestratorModelResearchLastJob
}

export async function POST(request: Request) {
    const registry = getEffectiveRegistry()
    const readiness = await getResearchRuntimeReadiness(registry)
    if (!readiness.available) {
        clearPersistedJobSnapshot()
        return Response.json({
            error: readiness.chatMessage ?? readiness.unavailableReason ?? 'Model research requires a usable provider.',
        }, { status: 409 })
    }

    const job = getOrStartResearchJob()
    return researchStreamResponse(job, request)
}

export async function GET() {
    const registry = getEffectiveRegistry()
    const availableProviders = await availableModelProviderIds(registry)
    if (availableProviders.size === 0) {
        const running = activeResearchJob()
        if (running) running.controller.abort(new Error('No usable model provider is configured.'))
        researchGlobals().__orchestratorModelResearchLastJob = undefined
        clearPersistedJobSnapshot()
        return idleResearchResponse()
    }

    const job = latestResearchJob()
    if (job) {
        return Response.json({
            running: job.status === 'running',
            runId: job.id,
            status: job.status,
            startedAt: job.startedAt,
            endedAt: job.endedAt ?? null,
            concurrency: job.concurrency,
            events: job.events,
        }, { headers: { 'Cache-Control': 'no-store' } })
    }

    // No in-memory job (fresh process / after restart). Fall back to the last
    // persisted run so a refresh shows the real outcome, not stale state.
    const persisted = readPersistedJobSnapshot()
    if (persisted) {
        const crashedMidRun = persisted.status === 'running'
        const events = crashedMidRun
            ? [...persisted.events, { type: 'stopped' as const, runId: persisted.runId, message: 'Research interrupted by a server restart', at: persisted.endedAt ?? Date.now() }]
            : persisted.events
        return Response.json({
            running: false,
            runId: persisted.runId,
            status: crashedMidRun ? 'stopped' : persisted.status,
            startedAt: persisted.startedAt,
            endedAt: persisted.endedAt,
            concurrency: persisted.concurrency,
            events,
        }, { headers: { 'Cache-Control': 'no-store' } })
    }

    return idleResearchResponse()
}

export async function DELETE() {
    const job = activeResearchJob()
    if (!job) {
        researchGlobals().__orchestratorModelResearchLastJob = undefined
        clearPersistedJobSnapshot()
        return Response.json({ stopped: false, cleared: true, message: 'No model research run is active.' })
    }
    job.controller.abort(new Error('Research stopped'))
    return Response.json({ stopped: true, message: 'Research stop requested.' })
}

function getOrStartResearchJob(): ActiveResearchJob {
    const existing = activeResearchJob()
    if (existing) return existing

    const job: ActiveResearchJob = {
        id: `model_research_${randomUUID()}`,
        controller: new AbortController(),
        startedAt: Date.now(),
        concurrency: MODEL_RESEARCH_CONCURRENCY,
        status: 'running',
        events: [],
        subscribers: new Set(),
        promise: Promise.resolve(),
    }
    researchGlobals().__orchestratorModelResearchJob = job
    researchGlobals().__orchestratorModelResearchLastJob = job
    job.promise = runResearchJob(job).finally(() => {
        if (researchGlobals().__orchestratorModelResearchJob?.id === job.id) {
            researchGlobals().__orchestratorModelResearchJob = undefined
        }
        researchGlobals().__orchestratorModelResearchLastJob = job
    })
    return job
}

function researchStreamResponse(job: ActiveResearchJob, request: Request): Response {
    const encoder = new TextEncoder()

    const stream = new ReadableStream({
        start(controller) {
            let closed = false
            let cleanup = () => {}
            const close = () => {
                if (closed) return
                closed = true
                cleanup()
                try {
                    controller.close()
                } catch {
                    // The client may already have disconnected.
                }
            }
            const send = (event: ResearchEvent) => {
                if (closed) return
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
            }
            const subscriber = (event: ResearchEvent) => {
                send(event)
                if (isTerminalResearchEvent(event)) close()
            }
            const heartbeat = setInterval(() => {
                if (closed) return
                try {
                    controller.enqueue(encoder.encode(': ping\n\n'))
                } catch {
                    close()
                }
            }, 15_000)
            const abort = () => close()
            cleanup = () => {
                clearInterval(heartbeat)
                job.subscribers.delete(subscriber)
                request.signal.removeEventListener('abort', abort)
            }
            request.signal.addEventListener('abort', abort, { once: true })

            for (const event of job.events) {
                send(event)
                if (closed) return
            }
            if (job.status !== 'running') {
                close()
                return
            }
            job.subscribers.add(subscriber)
        },
    })

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        },
    })
}

async function runResearchJob(job: ActiveResearchJob): Promise<void> {
    let updated = 0
    let incomplete = 0
    let failed = 0

    try {
        const registry = getEffectiveRegistry()
        const readiness = await getResearchRuntimeReadiness(registry)
        if (!readiness.available) {
            throw new Error(readiness.chatMessage ?? readiness.unavailableReason ?? 'Model research requires a usable provider.')
        }
        const targets = await activeResearchTargets(registry)
        const concurrency = targets.length === 0 ? 0 : Math.min(MODEL_RESEARCH_CONCURRENCY, targets.length)
        job.concurrency = concurrency
        emitResearchEvent(job, { type: 'ready', runId: job.id, total: targets.length, concurrency })

        await mapResearchTargets(targets, concurrency, job.controller.signal, async (target, index) => {
            if (job.controller.signal.aborted) return

            const key = curatedKey(target.providerId, target.modelId)
            emitResearchEvent(job, {
                type: 'model_start',
                key,
                providerId: target.providerId,
                modelId: target.modelId,
                name: target.model.name,
                index: index + 1,
                total: targets.length,
                missing: target.model.missingFields,
            })

            try {
                const result = await researchOneModelWithRetries({
                    target,
                    signal: job.controller.signal,
                    onAgentEvent: event => emitResearchEvent(job, { type: 'agent_event', key, event }),
                    onRetry: retry => emitResearchEvent(job, { type: 'model_retry', key, ...retry }),
                })
                if (job.controller.signal.aborted) return

                if (!result.success) {
                    failed += 1
                    emitResearchEvent(job, { type: 'model_result', key, status: 'failed', error: result.error })
                    return
                }

                if (result.changed) updated += 1
                if (result.status === 'incomplete') incomplete += 1
                emitResearchEvent(job, {
                    type: 'model_result',
                    key,
                    status: result.status,
                    summary: result.summary,
                    remainingMissing: result.remainingMissing,
                    unresolved: result.unresolved,
                    model: result.model,
                })
            } catch (err) {
                if (job.controller.signal.aborted) return
                failed += 1
                emitResearchEvent(job, {
                    type: 'model_result',
                    key,
                    status: 'failed',
                    error: err instanceof Error ? err.message : 'Unknown research error',
                })
            }
        })

        if (job.controller.signal.aborted) {
            job.status = 'stopped'
            emitResearchEvent(job, { type: 'stopped', runId: job.id, message: 'Research stopped' })
        } else {
            job.status = 'done'
            emitResearchEvent(job, { type: 'done', runId: job.id, total: targets.length, updated, incomplete, failed })
        }
    } catch (err) {
        if (job.controller.signal.aborted) {
            job.status = 'stopped'
            emitResearchEvent(job, { type: 'stopped', runId: job.id, message: 'Research stopped' })
        } else {
            job.status = 'error'
            emitResearchEvent(job, { type: 'error', runId: job.id, message: err instanceof Error ? err.message : 'Unknown research run error' })
        }
    } finally {
        job.endedAt = Date.now()
        persistJobSnapshot(job)
    }
}

function emitResearchEvent(job: ActiveResearchJob, event: ResearchEvent): void {
    const stamped = event.at === undefined ? { ...event, at: Date.now() } : event
    job.events.push(stamped)
    if (job.events.length > MODEL_RESEARCH_EVENT_LIMIT) {
        job.events.splice(0, job.events.length - MODEL_RESEARCH_EVENT_LIMIT)
    }
    // Mirror structural events to disk (bounded volume — agent transcript is
    // excluded) so a refresh after a restart still rebuilds the run state.
    if (stamped.type !== 'agent_event') persistJobSnapshot(job)
    for (const subscriber of [...job.subscribers]) {
        subscriber(stamped)
    }
}

function isTerminalResearchEvent(event: ResearchEvent): boolean {
    return event.type === 'done' || event.type === 'stopped' || event.type === 'error'
}

function containsLegacyCodexMcpTransportError(events: ResearchEvent[]): boolean {
    return events.some(event => {
        if (event.type === 'error') return isLegacyCodexMcpTransportError(event.message)
        if (event.type === 'model_result') return isLegacyCodexMcpTransportError(event.error)
        return false
    })
}

function isLegacyCodexMcpTransportError(value: unknown): boolean {
    return typeof value === 'string'
        && value.includes('invalid transport')
        && value.includes('mcp_servers.playwright')
}

async function mapResearchTargets(
    targets: ResearchTarget[],
    concurrency: number,
    signal: AbortSignal,
    mapper: (target: ResearchTarget, index: number) => Promise<void>
): Promise<void> {
    if (concurrency <= 0 || targets.length === 0) return
    let next = 0
    async function worker() {
        for (;;) {
            if (signal.aborted) return
            const index = next++
            if (index >= targets.length) return
            await mapper(targets[index], index)
        }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()))
}

async function activeResearchTargets(registry: ReturnType<typeof getEffectiveRegistry>) {
    const availableProviders = await availableModelProviderIds(registry)
    const targets: ResearchTarget[] = []
    for (const [providerId, provider] of Object.entries(registry)) {
        if (providerId === 'browser') continue
        if (!availableProviders.has(providerId)) continue
        for (const [modelId, model] of Object.entries(provider.models)) {
            if (model.archived) continue
            if (model.dataCompleteness !== 'incomplete') continue
            targets.push({ providerId, modelId, model })
        }
    }
    return targets.sort((a, b) => {
        const aMissing = a.model.missingFields.length
        const bMissing = b.model.missingFields.length
        if (aMissing === bMissing) return a.providerId.localeCompare(b.providerId) || a.model.name.localeCompare(b.model.name)
        return bMissing - aMissing
    })
}

async function availableModelProviderIds(registry: ReturnType<typeof getEffectiveRegistry>): Promise<Set<string>> {
    const statuses = await getProviderReadinessMap(registry)
    return new Set(
        Object.entries(statuses)
            .filter(([providerId, status]) => providerId !== 'browser' && status.available)
            .map(([providerId]) => providerId)
    )
}

async function getResearchRuntimeReadiness(registry: ReturnType<typeof getEffectiveRegistry>) {
    const runtime = getEffectiveAgentSettings(researcher.id)
    return getProviderReadiness(runtime.provider, registry[runtime.provider])
}

type ResearchOneModelResult = Awaited<ReturnType<typeof researchOneModel>>

async function researchOneModelWithRetries(args: {
    target: { providerId: string; modelId: string; model: EffectiveModelEntry }
    signal: AbortSignal
    onAgentEvent: (event: AgentRunEvent) => void
    onRetry: (event: { attempt: number; maxAttempts: number; reason: string }) => void
}): Promise<ResearchOneModelResult> {
    let lastError = 'Researcher failed'

    for (let attempt = 1; attempt <= MODEL_RESEARCH_MAX_ATTEMPTS; attempt++) {
        if (args.signal.aborted) return { success: false, error: 'Research stopped' }

        const attemptSignal = createAttemptSignal(args.signal, MODEL_RESEARCH_ATTEMPT_TIMEOUT_MS)
        try {
            const result = await researchOneModel(args.target, attemptSignal.signal, args.onAgentEvent)
            if (result.success) return result
            lastError = attemptSignal.timedOut()
                ? `Timed out after ${formatDurationMs(MODEL_RESEARCH_ATTEMPT_TIMEOUT_MS)}`
                : result.error
        } catch (err) {
            lastError = attemptSignal.timedOut()
                ? `Timed out after ${formatDurationMs(MODEL_RESEARCH_ATTEMPT_TIMEOUT_MS)}`
                : err instanceof Error ? err.message : 'Unknown research error'
        } finally {
            attemptSignal.cleanup()
        }

        if (args.signal.aborted) return { success: false, error: 'Research stopped' }
        if (attempt < MODEL_RESEARCH_MAX_ATTEMPTS) {
            args.onRetry({
                attempt: attempt + 1,
                maxAttempts: MODEL_RESEARCH_MAX_ATTEMPTS,
                reason: lastError,
            })
        }
    }

    return { success: false, error: lastError }
}

function createAttemptSignal(parent: AbortSignal, timeoutMs: number): { signal: AbortSignal; cleanup: () => void; timedOut: () => boolean } {
    const controller = new AbortController()
    let didTimeout = false

    const abortFromParent = () => controller.abort(parent.reason)
    if (parent.aborted) abortFromParent()
    else parent.addEventListener('abort', abortFromParent, { once: true })

    const timer = setTimeout(() => {
        didTimeout = true
        controller.abort(new Error(`Timed out after ${formatDurationMs(timeoutMs)}`))
    }, timeoutMs)

    return {
        signal: controller.signal,
        cleanup: () => {
            clearTimeout(timer)
            parent.removeEventListener('abort', abortFromParent)
        },
        timedOut: () => didTimeout,
    }
}

function formatDurationMs(ms: number): string {
    const seconds = Math.round(ms / 1000)
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    const rest = seconds % 60
    return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`
}

async function researchOneModel(
    target: { providerId: string; modelId: string; model: EffectiveModelEntry },
    signal: AbortSignal,
    onAgentEvent: (event: AgentRunEvent) => void
): Promise<{
    success: true
    changed: boolean
    status: Exclude<ResearchModelStatus, 'failed'>
    summary?: string
    remainingMissing: ModelDataField[]
    unresolved?: UnresolvedField[]
    model: EffectiveModelEntry
} | { success: false; error: string }> {
    const parentRequestId = `model_research_${randomUUID()}`
    const parentCtx: ToolExecutionContext = {
        callerAgentId: 'orchestrator',
        depth: 0,
        conversationId: `model_research_${Date.now()}`,
        parentRequestId,
        signal,
        onAgentEvent,
    }

    const result = await runTextSubAgent({
        target: researcher,
        prompt: buildModelMetadataResearchPrompt(target),
        parentCtx,
    })

    if (!result.success) {
        return { success: false, error: result.error ?? 'Researcher failed' }
    }

    const output = readResearchOutput(result.data)
    const parsedJson = parseJsonFromText(output)
    const parsed = ResearchResultSchema.safeParse(parsedJson)
    if (!parsed.success) {
        return { success: false, error: `Researcher returned invalid metadata JSON: ${parsed.error.message}` }
    }

    const before = target.model
    const beforeMissing = before.missingFields
    const now = Date.now()
    const fields = normalizeResearchFields(parsed.data.fields ?? {}, target.providerId)
    const patch: CuratedModelEntry = {
        ...fields,
        lastResearchedAt: now,
    }
    if (parsed.data.sources?.length) {
        patch.researchSources = parsed.data.sources.map(source => ({
            ...source,
            accessedAt: source.accessedAt ?? now,
        }))
    }

    const cleaned = CuratedModelEntrySchema.parse(stripUndefined(patch))
    const updatedRegistry = patchCuratedModel(target.providerId, target.modelId, cleaned)
    const after = updatedRegistry[target.providerId]?.models[target.modelId] ?? before
    const changedFields = changedFieldNames(before, after, fields)
    const changed = changedFields.length > 0
    const remainingMissing = after.missingFields
    const status: Exclude<ResearchModelStatus, 'failed'> = remainingMissing.length > 0
        ? 'incomplete'
        : changed
            ? 'updated'
            : 'unchanged'

    return {
        success: true,
        changed,
        status,
        summary: buildResultSummary({
            summary: parsed.data.summary,
            changedFields,
            beforeMissing,
            remainingMissing,
            unresolved: parsed.data.unresolved,
        }),
        remainingMissing,
        unresolved: parsed.data.unresolved,
        model: after,
    }
}

function readResearchOutput(data: unknown): string {
    if (!data || typeof data !== 'object') return ''
    const output = (data as { output?: unknown }).output
    return typeof output === 'string' ? output : ''
}

function parseJsonFromText(text: string): unknown {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (!fenced && (start < 0 || end <= start)) {
        throw new Error('Researcher returned no JSON object')
    }
    const candidate = fenced?.[1] ?? text.slice(start, end + 1)
    return JSON.parse(candidate)
}

function changedFieldNames(
    before: EffectiveModelEntry,
    after: EffectiveModelEntry,
    fields: z.infer<typeof ResearchFieldsSchema>
): string[] {
    const labels: Record<string, string> = {
        pricing: 'pricing',
        pricingNotes: 'pricing notes',
        contextWindow: 'context window',
        maxOutputTokens: 'max output',
        knowledgeCutoff: 'knowledge cutoff',
        thinkingLevels: 'thinking levels',
        defaultThinkingLevel: 'default thinking',
        capabilities: 'capabilities',
        features: 'features',
        customMetadata: 'custom metadata',
        intelligenceTier: 'intelligence tier',
        kinds: 'model kinds',
        notes: 'notes',
    }
    const out: string[] = []
    for (const key of Object.keys(fields) as Array<keyof typeof fields>) {
        if (fields[key] === undefined) continue
        if (JSON.stringify(before[key as keyof EffectiveModelEntry] ?? null) !== JSON.stringify(after[key as keyof EffectiveModelEntry] ?? null)) {
            out.push(labels[String(key)] ?? String(key))
        }
    }
    return out
}

function buildResultSummary(args: {
    summary?: string
    changedFields: string[]
    beforeMissing: ModelDataField[]
    remainingMissing: ModelDataField[]
    unresolved?: UnresolvedField[]
}): string {
    const parts: string[] = []
    if (args.summary) parts.push(args.summary)
    if (args.changedFields.length > 0) parts.push(`Updated ${args.changedFields.join(', ')}`)
    if (args.remainingMissing.length > 0) {
        const remaining = args.remainingMissing.map(formatMissingField).join(', ')
        const before = args.beforeMissing.length > 0 ? ` from ${args.beforeMissing.map(formatMissingField).join(', ')}` : ''
        parts.push(`Still missing ${remaining}${before ? ` (started${before})` : ''}`)
    }
    if (args.unresolved?.length) {
        const unresolved = args.unresolved
            .slice(0, 3)
            .map(item => item.reason ? `${formatMissingField(item.field)}: ${item.reason}` : formatMissingField(item.field))
            .join('; ')
        parts.push(`Unresolved: ${unresolved}`)
    }
    return parts.join(' · ') || 'No supported metadata changes found.'
}

type ResearchFields = z.infer<typeof ResearchFieldsSchema>
const NON_SELECTABLE_THINKING_LEVELS = new Set(['off', 'auto', 'enabled', 'disabled', 'reasoning', 'thinking'])

function normalizeResearchFields(fields: ResearchFields, providerId: string): ResearchFields {
    const out: ResearchFields = { ...fields }
    const nonSelectable = new Set(NON_SELECTABLE_THINKING_LEVELS)
    if (providerId !== 'openai' && providerId !== 'codex') nonSelectable.add('none')
    if (out.thinkingLevels !== undefined) {
        const wasExplicitlyEmpty = out.thinkingLevels.length === 0
        const seen = new Set<string>()
        const levels = out.thinkingLevels.filter(level => {
            const normalized = stableToken(level)
            if (!normalized || nonSelectable.has(normalized) || seen.has(normalized)) return false
            seen.add(normalized)
            return true
        })
        if (levels.length > 0) out.thinkingLevels = levels
        else if (wasExplicitlyEmpty) out.thinkingLevels = []
        else delete out.thinkingLevels
    }

    if (out.defaultThinkingLevel) {
        const normalized = stableToken(out.defaultThinkingLevel)
        const allowed = out.thinkingLevels?.includes(out.defaultThinkingLevel)
        if (!normalized || nonSelectable.has(normalized)) {
            delete out.defaultThinkingLevel
        } else if (out.thinkingLevels && !allowed) {
            if (out.thinkingLevels.length > 0) out.defaultThinkingLevel = out.thinkingLevels[0]
            else delete out.defaultThinkingLevel
        }
    }

    return out
}

function stableToken(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function formatMissingField(field: ModelDataField): string {
    if (field === 'contextWindow') return 'context window'
    if (field === 'maxOutputTokens') return 'max output'
    if (field === 'knowledgeCutoff') return 'knowledge cutoff'
    if (field === 'thinkingLevels') return 'thinking levels'
    if (field === 'defaultThinkingLevel') return 'default thinking'
    return field
}

function stripUndefined(value: CuratedModelEntry): CuratedModelEntry {
    const out: CuratedModelEntry = {}
    for (const [key, entryValue] of Object.entries(value) as Array<[keyof CuratedModelEntry, CuratedModelEntry[keyof CuratedModelEntry]]>) {
        if (entryValue !== undefined) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ;(out as any)[key] = entryValue
        }
    }
    return out
}
