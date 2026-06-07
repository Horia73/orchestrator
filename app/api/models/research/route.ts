import { randomUUID } from 'crypto'
import fs from 'fs'
import path from 'path'

import { modelMetadataResearcher } from '@/lib/ai/agents/model-metadata-researcher'
import { runTextSubAgent } from '@/lib/ai/agents/runner'
import type { AgentRunEvent, ToolExecutionContext } from '@/lib/ai/agents/types'
import {
    buildProviderMetadataResearchPrompt,
    buildSingleModelMetadataResearchPrompt,
} from '@/lib/ai/prompts/model-metadata-research'
import { getEffectiveAgentSettings } from '@/lib/config'
import {
    CuratedModelEntrySchema,
    curatedKey,
    type CuratedModelEntry,
    type EffectiveModelEntry,
    type ModelDataField,
} from '@/lib/models/schema'
import { getEffectiveRegistry, patchCuratedModel } from '@/lib/models/registry'
import { getProviderReadiness, getProviderReadinessMap } from '@/lib/provider-readiness'
import { runWithAdminCookieProfile, runWithRequestProfile } from "@/lib/profiles/server"
import {
    ProviderResearchResultSchema,
    ResearchResultSchema,
    buildResultSummary,
    changedFieldNames,
    normalizeResearchFields,
    parseJsonFromText,
    readResearchOutput,
    stripUndefined,
    type PerModelResearchResult,
    type ResearchFields,
    type UnresolvedField,
} from './route-support'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MODEL_RESEARCH_MAX_ATTEMPTS = 2
// One attempt covers one batch of incomplete models of a single provider in
// one agent call. 20 minutes accommodates the heavier task while still
// capping the long-tail; the per-model fallback path picks up any model the
// batch didn't deliver.
const MODEL_RESEARCH_ATTEMPT_TIMEOUT_MS = 20 * 60 * 1000
const MODEL_RESEARCH_CONCURRENCY = 6
const MODEL_RESEARCH_EVENT_LIMIT = 500
// Upper bound on models per batched agent call. Picked from the trade-off
// between amortization (one page fetch covers many models on shared-pricing
// providers like Anthropic/OpenAI) and risk (more rows on the same page =
// more chance of the agent confusing rows / output overflow). The
// duplicate-fields hallucination guard catches row-copies if the model
// stumbles. Providers with more incomplete models are split into balanced
// chunks of <= this size. Tune here if a provider's batches start producing
// suspicious duplicates or output truncation.
const MODEL_RESEARCH_BATCH_MAX_PER_CHUNK = 10

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

type ProviderResearchTarget = {
    providerId: string
    providerName: string
    models: Array<{ modelId: string; model: EffectiveModelEntry; globalIndex: number }>
}

type SingleModelTarget = { providerId: string; modelId: string }

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
    // When set, the run targets exactly this model (even if already complete)
    // instead of the full set of incomplete models. Drives the per-model
    // "re-research" button.
    target?: SingleModelTarget
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
  return runWithRequestProfile(request, async () => {
        const registry = getEffectiveRegistry()
        const readiness = await getResearchRuntimeReadiness(registry)
        if (!readiness.available) {
            clearPersistedJobSnapshot()
            return Response.json({
                error: readiness.chatMessage ?? readiness.unavailableReason ?? 'Model research requires a usable provider.',
            }, { status: 409 })
        }

        const parsed = await parseResearchTarget(request, registry)
        if (parsed && 'error' in parsed) {
            return Response.json({ error: parsed.error }, { status: parsed.status })
        }
        // A single-model re-research can't piggyback on an in-flight run — its
        // stream would surface the unrelated active job. Require a clean slate.
        if (parsed && activeResearchJob()) {
            return Response.json({
                error: 'A research run is already active. Stop it before re-researching a single model.',
            }, { status: 409 })
        }

        const job = getOrStartResearchJob(parsed ?? undefined)
        return researchStreamResponse(job, request)
  })
}

// Parse an optional `{ providerId, modelId }` body that narrows the run to one
// model. Returns null for a bodyless request (full incomplete-model run), the
// validated target, or an error envelope to surface to the caller.
async function parseResearchTarget(
    request: Request,
    registry: ReturnType<typeof getEffectiveRegistry>
): Promise<SingleModelTarget | { error: string; status: number } | null> {
    let body: unknown
    try {
        body = await request.json()
    } catch {
        return null
    }
    if (!body || typeof body !== 'object') return null
    const providerId = (body as Record<string, unknown>).providerId
    const modelId = (body as Record<string, unknown>).modelId
    if (typeof providerId !== 'string' || typeof modelId !== 'string' || !providerId || !modelId) {
        return null
    }
    const available = await availableModelProviderIds(registry)
    if (!available.has(providerId)) {
        return { error: `Provider ${providerId} is not available for research.`, status: 409 }
    }
    if (!registry[providerId]?.models[modelId]) {
        return { error: `Model ${providerId}:${modelId} was not found.`, status: 404 }
    }
    return { providerId, modelId }
}

export async function GET() {
  return runWithAdminCookieProfile(async () => {
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
  })
}

export async function DELETE() {
  return runWithAdminCookieProfile(async () => {
        const job = activeResearchJob()
        if (!job) {
            researchGlobals().__orchestratorModelResearchLastJob = undefined
            clearPersistedJobSnapshot()
            return Response.json({ stopped: false, cleared: true, message: 'No model research run is active.' })
        }
        job.controller.abort(new Error('Research stopped'))
        return Response.json({ stopped: true, message: 'Research stop requested.' })
  })
}

function getOrStartResearchJob(target?: SingleModelTarget): ActiveResearchJob {
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
        target,
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
        const providerTargets = job.target
            ? await singleModelResearchTargets(registry, job.target)
            : await activeProviderResearchTargets(registry)
        const totalModels = providerTargets.reduce((sum, p) => sum + p.models.length, 0)
        const concurrency = providerTargets.length === 0 ? 0 : Math.min(MODEL_RESEARCH_CONCURRENCY, providerTargets.length)
        job.concurrency = concurrency
        emitResearchEvent(job, { type: 'ready', runId: job.id, total: totalModels, concurrency })

        await mapConcurrent(providerTargets, concurrency, job.controller.signal, async (providerTarget) => {
            if (job.controller.signal.aborted) return
            const counters = await researchOneProviderBatch({
                job,
                providerTarget,
                totalModels,
            })
            updated += counters.updated
            incomplete += counters.incomplete
            failed += counters.failed
        })

        if (job.controller.signal.aborted) {
            job.status = 'stopped'
            emitResearchEvent(job, { type: 'stopped', runId: job.id, message: 'Research stopped' })
        } else {
            job.status = 'done'
            emitResearchEvent(job, { type: 'done', runId: job.id, total: totalModels, updated, incomplete, failed })
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

// Per-provider batch driver. Emits model_start for every model in the batch
// up-front (so the UI shows the run list immediately), runs ONE agent call
// covering all of them, dispatches the parsed perModel entries, and falls
// back to per-model research for any model the batch missed or duplicated.
async function researchOneProviderBatch(args: {
    job: ActiveResearchJob
    providerTarget: ProviderResearchTarget
    totalModels: number
}): Promise<{ updated: number; incomplete: number; failed: number }> {
    const { job, providerTarget, totalModels } = args
    const counters = { updated: 0, incomplete: 0, failed: 0 }
    if (providerTarget.models.length === 0) return counters

    // Emit model_start for every model in this provider's batch. The UI keys
    // runs by curatedKey, so each model gets its own row from the start.
    for (const entry of providerTarget.models) {
        const key = curatedKey(providerTarget.providerId, entry.modelId)
        emitResearchEvent(job, {
            type: 'model_start',
            key,
            providerId: providerTarget.providerId,
            modelId: entry.modelId,
            name: entry.model.name,
            index: entry.globalIndex + 1,
            total: totalModels,
            missing: entry.model.missingFields,
        })
    }

    // Agent transcript needs ONE key for streaming. Use the first model's key
    // as the primary; the rest stay listed but quiet until model_result.
    const primaryKey = curatedKey(providerTarget.providerId, providerTarget.models[0].modelId)

    const batch = await researchOneProviderWithRetries({
        providerTarget,
        signal: job.controller.signal,
        onAgentEvent: event => emitResearchEvent(job, { type: 'agent_event', key: primaryKey, event }),
        onRetry: retry => emitResearchEvent(job, { type: 'model_retry', key: primaryKey, ...retry }),
    })

    if (job.controller.signal.aborted) return counters

    // Index the perModel array by modelId for fast lookup, ignoring any
    // entries whose modelId isn't in the input (hallucinated id).
    const inputIds = new Set(providerTarget.models.map(m => m.modelId))
    const perModelByModelId = new Map<string, PerModelResearchResult>()
    if (batch.success) {
        for (const entry of batch.perModel) {
            if (entry.providerId !== providerTarget.providerId) continue
            if (!inputIds.has(entry.modelId)) continue
            if (perModelByModelId.has(entry.modelId)) continue
            perModelByModelId.set(entry.modelId, entry)
        }
    }

    const suspicious = batch.success ? detectDuplicateFields(batch.perModel.filter(e => inputIds.has(e.modelId))) : new Set<string>()

    for (const entry of providerTarget.models) {
        if (job.controller.signal.aborted) return counters
        const key = curatedKey(providerTarget.providerId, entry.modelId)
        const perModel = perModelByModelId.get(entry.modelId)
        const isHallucinated = suspicious.has(entry.modelId)
        const needsFallback = !batch.success || !perModel || isHallucinated

        if (!needsFallback) {
            try {
                const applied = applyPerModelPatch({
                    providerId: providerTarget.providerId,
                    modelId: entry.modelId,
                    before: entry.model,
                    perModel: perModel!,
                    sharedSources: batch.sources,
                })
                if (applied.changed) counters.updated += 1
                if (applied.status === 'incomplete') counters.incomplete += 1
                emitResearchEvent(job, {
                    type: 'model_result',
                    key,
                    status: applied.status,
                    summary: applied.summary,
                    remainingMissing: applied.remainingMissing,
                    unresolved: applied.unresolved,
                    model: applied.model,
                })
            } catch (err) {
                counters.failed += 1
                emitResearchEvent(job, {
                    type: 'model_result',
                    key,
                    status: 'failed',
                    error: err instanceof Error ? err.message : 'Failed to apply batched research result',
                })
            }
            continue
        }

        // Fallback: research this single model in isolation. Reasons:
        // batch failed entirely / model missing from batch / batch returned
        // two models with identical fields (likely row-copy hallucination).
        try {
            const fallback = await researchOneModelFallback({
                target: { providerId: providerTarget.providerId, modelId: entry.modelId, model: entry.model },
                signal: job.controller.signal,
                onAgentEvent: event => emitResearchEvent(job, { type: 'agent_event', key, event }),
            })
            if (job.controller.signal.aborted) return counters
            if (!fallback.success) {
                counters.failed += 1
                emitResearchEvent(job, { type: 'model_result', key, status: 'failed', error: fallback.error })
                continue
            }
            if (fallback.changed) counters.updated += 1
            if (fallback.status === 'incomplete') counters.incomplete += 1
            emitResearchEvent(job, {
                type: 'model_result',
                key,
                status: fallback.status,
                summary: isHallucinated ? `[fallback after suspected row-copy] ${fallback.summary ?? ''}`.trim() : fallback.summary,
                remainingMissing: fallback.remainingMissing,
                unresolved: fallback.unresolved,
                model: fallback.model,
            })
        } catch (err) {
            if (job.controller.signal.aborted) return counters
            counters.failed += 1
            emitResearchEvent(job, {
                type: 'model_result',
                key,
                status: 'failed',
                error: err instanceof Error ? err.message : 'Unknown research error',
            })
        }
    }

    return counters
}

// A modelId is suspicious when its fields blob is deep-equal to that of
// another distinct modelId in the same provider batch. This is the strongest
// "row-copy hallucination" signal: real models usually differ on at least one
// field (notes, knowledgeCutoff, intelligenceTier, ...). Both members of any
// matched pair get flagged and fall back to per-model research.
function detectDuplicateFields(entries: PerModelResearchResult[]): Set<string> {
    const flagged = new Set<string>()
    for (let i = 0; i < entries.length; i++) {
        const a = entries[i]
        if (!a.fields || Object.keys(a.fields).length === 0) continue
        const sa = JSON.stringify(a.fields)
        for (let j = i + 1; j < entries.length; j++) {
            const b = entries[j]
            if (!b.fields) continue
            if (a.modelId === b.modelId) continue
            if (sa === JSON.stringify(b.fields)) {
                flagged.add(a.modelId)
                flagged.add(b.modelId)
            }
        }
    }
    return flagged
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

async function mapConcurrent<T>(
    items: T[],
    concurrency: number,
    signal: AbortSignal,
    mapper: (item: T, index: number) => Promise<void>
): Promise<void> {
    if (concurrency <= 0 || items.length === 0) return
    let next = 0
    async function worker() {
        for (;;) {
            if (signal.aborted) return
            const index = next++
            if (index >= items.length) return
            await mapper(items[index], index)
        }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()))
}

// Group incomplete models by provider, then split each provider into balanced
// chunks of at most MODEL_RESEARCH_BATCH_MAX_PER_CHUNK models, then interleave
// chunks across providers so a big provider's chunks don't monopolize the
// first wave of the concurrency pool.
//
// Within a provider, models are ordered by missing-field count (most-incomplete
// first) and then by name. Providers themselves are ordered alphabetically by
// id. Each model gets a stable `globalIndex` (assigned BEFORE chunking) so the
// UI's "X / N" progress reflects display order, not execution order.
async function activeProviderResearchTargets(registry: ReturnType<typeof getEffectiveRegistry>): Promise<ProviderResearchTarget[]> {
    const availableProviders = await availableModelProviderIds(registry)
    const providers: ProviderResearchTarget[] = []
    for (const [providerId, provider] of Object.entries(registry)) {
        if (providerId === 'browser') continue
        if (!availableProviders.has(providerId)) continue
        const models: Array<{ modelId: string; model: EffectiveModelEntry; globalIndex: number }> = []
        for (const [modelId, model] of Object.entries(provider.models)) {
            if (model.archived) continue
            if (model.dataCompleteness !== 'incomplete') continue
            models.push({ modelId, model, globalIndex: 0 })
        }
        if (models.length === 0) continue
        models.sort((a, b) => {
            const aMissing = a.model.missingFields.length
            const bMissing = b.model.missingFields.length
            if (aMissing === bMissing) return a.model.name.localeCompare(b.model.name)
            return bMissing - aMissing
        })
        providers.push({ providerId, providerName: provider.name, models })
    }
    providers.sort((a, b) => a.providerId.localeCompare(b.providerId))
    let cursor = 0
    for (const p of providers) {
        for (const m of p.models) m.globalIndex = cursor++
    }

    // Chunk each provider's models, then round-robin across providers.
    const chunksByProvider: ProviderResearchTarget[][] = providers.map(p => {
        const slices = chunkBalanced(p.models, MODEL_RESEARCH_BATCH_MAX_PER_CHUNK)
        return slices.map(slice => ({
            providerId: p.providerId,
            providerName: p.providerName,
            models: slice,
        }))
    })
    return interleaveRoundRobin(chunksByProvider)
}

// Balanced split: distribute N items into chunks of at most `max` so that the
// chunk-size spread is at most 1. Uses floor + remainder distribution so a
// list of 13 with max 10 becomes [5, 4, 4], not the greedy [10, 3]. No chunk
// ever exceeds `max`; no chunk is empty unless the input is empty.
function chunkBalanced<T>(items: T[], max: number): T[][] {
    if (items.length === 0) return []
    if (items.length <= max) return [items]
    const numChunks = Math.ceil(items.length / max)
    const base = Math.floor(items.length / numChunks)
    const remainder = items.length % numChunks
    const out: T[][] = []
    let cursor = 0
    for (let i = 0; i < numChunks; i++) {
        const size = base + (i < remainder ? 1 : 0)
        out.push(items.slice(cursor, cursor + size))
        cursor += size
    }
    return out
}

// Round-robin merge a list of per-provider chunk-lists into one flat list.
// Given [[g1, g2, g3], [a1], [o1, o2]] returns [g1, a1, o1, g2, o2, g3]. With
// concurrency 6, the first wave touches every provider with at least one
// chunk, so the UI shows progress on all of them immediately instead of
// waiting for the biggest provider to drain.
function interleaveRoundRobin<T>(lists: T[][]): T[] {
    const queues = lists.map(l => [...l])
    const out: T[] = []
    let progress = true
    while (progress) {
        progress = false
        for (const q of queues) {
            const next = q.shift()
            if (next !== undefined) {
                out.push(next)
                progress = true
            }
        }
    }
    return out
}

// Build a one-model target list for a per-model re-research. Unlike the full
// run, this ignores dataCompleteness (so an already-complete model can be
// refreshed) but still requires the provider to be available and the model to
// exist. Returns [] if either check fails, which surfaces as a 0-model "done".
async function singleModelResearchTargets(
    registry: ReturnType<typeof getEffectiveRegistry>,
    target: SingleModelTarget
): Promise<ProviderResearchTarget[]> {
    const availableProviders = await availableModelProviderIds(registry)
    if (!availableProviders.has(target.providerId)) return []
    const provider = registry[target.providerId]
    const model = provider?.models[target.modelId]
    if (!provider || !model) return []
    return [{
        providerId: target.providerId,
        providerName: provider.name,
        models: [{ modelId: target.modelId, model, globalIndex: 0 }],
    }]
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
    const runtime = getEffectiveAgentSettings(modelMetadataResearcher.id)
    return getProviderReadiness(runtime.provider, registry[runtime.provider])
}

type ResearchOneModelResult = Awaited<ReturnType<typeof researchOneModel>>

type ProviderBatchSuccess = {
    success: true
    perModel: PerModelResearchResult[]
    sources: PerModelResearchResult['sources']
    summary?: string
}
type ProviderBatchResult = ProviderBatchSuccess | { success: false; error: string }

// Per-provider batch with retries. One attempt = one agent call covering all
// incomplete models of the provider. We retry on parse failure / timeout,
// like the old per-model flow did, but at provider granularity now.
async function researchOneProviderWithRetries(args: {
    providerTarget: ProviderResearchTarget
    signal: AbortSignal
    onAgentEvent: (event: AgentRunEvent) => void
    onRetry: (event: { attempt: number; maxAttempts: number; reason: string }) => void
}): Promise<ProviderBatchResult> {
    let lastError = 'Provider researcher failed'

    for (let attempt = 1; attempt <= MODEL_RESEARCH_MAX_ATTEMPTS; attempt++) {
        if (args.signal.aborted) return { success: false, error: 'Research stopped' }

        const attemptSignal = createAttemptSignal(args.signal, MODEL_RESEARCH_ATTEMPT_TIMEOUT_MS)
        try {
            const result = await researchOneProvider(args.providerTarget, attemptSignal.signal, args.onAgentEvent)
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

// Single-attempt fallback for one model. Used when the batched provider call
// fails to deliver this model (missing entry, hallucinated duplicate, parse
// failure). No retries — by the time we're here the batch attempt has already
// consumed time, and we want fallback to add at most one more timeout window.
async function researchOneModelFallback(args: {
    target: { providerId: string; modelId: string; model: EffectiveModelEntry }
    signal: AbortSignal
    onAgentEvent: (event: AgentRunEvent) => void
}): Promise<ResearchOneModelResult> {
    if (args.signal.aborted) return { success: false, error: 'Research stopped' }
    const attemptSignal = createAttemptSignal(args.signal, MODEL_RESEARCH_ATTEMPT_TIMEOUT_MS)
    try {
        return await researchOneModel(args.target, attemptSignal.signal, args.onAgentEvent)
    } catch (err) {
        return {
            success: false,
            error: attemptSignal.timedOut()
                ? `Timed out after ${formatDurationMs(MODEL_RESEARCH_ATTEMPT_TIMEOUT_MS)}`
                : err instanceof Error ? err.message : 'Unknown research error',
        }
    } finally {
        attemptSignal.cleanup()
    }
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

type ResearchSuccess = {
    success: true
    changed: boolean
    status: Exclude<ResearchModelStatus, 'failed'>
    summary?: string
    remainingMissing: ModelDataField[]
    unresolved?: UnresolvedField[]
    model: EffectiveModelEntry
}

// Single-model agent call. Used by the per-model fallback path; also still
// callable on its own. Returns the same shape as before; the new batched
// per-provider path returns the same shape per model via applyPerModelPatch.
async function researchOneModel(
    target: { providerId: string; modelId: string; model: EffectiveModelEntry },
    signal: AbortSignal,
    onAgentEvent: (event: AgentRunEvent) => void
): Promise<ResearchSuccess | { success: false; error: string }> {
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
        target: modelMetadataResearcher,
        prompt: buildSingleModelMetadataResearchPrompt(target),
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

    return applyResearchPatch({
        providerId: target.providerId,
        modelId: target.modelId,
        before: target.model,
        fieldsRaw: parsed.data.fields ?? {},
        sources: parsed.data.sources,
        summary: parsed.data.summary,
        unresolved: parsed.data.unresolved,
    })
}

// Per-provider batch agent call. One agent run, one JSON envelope, N models
// in the perModel array. Used by researchOneProviderBatch (with retries).
async function researchOneProvider(
    providerTarget: ProviderResearchTarget,
    signal: AbortSignal,
    onAgentEvent: (event: AgentRunEvent) => void
): Promise<ProviderBatchResult> {
    const parentRequestId = `provider_research_${randomUUID()}`
    const parentCtx: ToolExecutionContext = {
        callerAgentId: 'orchestrator',
        depth: 0,
        conversationId: `model_research_${Date.now()}`,
        parentRequestId,
        signal,
        onAgentEvent,
    }

    const result = await runTextSubAgent({
        target: modelMetadataResearcher,
        prompt: buildProviderMetadataResearchPrompt({
            providerId: providerTarget.providerId,
            providerName: providerTarget.providerName,
            models: providerTarget.models.map(m => ({ modelId: m.modelId, model: m.model })),
        }),
        parentCtx,
    })

    if (!result.success) {
        return { success: false, error: result.error ?? 'Provider researcher failed' }
    }

    const output = readResearchOutput(result.data)
    let parsedJson: unknown
    try {
        parsedJson = parseJsonFromText(output)
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : 'Provider researcher returned no JSON object' }
    }
    const parsed = ProviderResearchResultSchema.safeParse(parsedJson)
    if (!parsed.success) {
        return { success: false, error: `Provider researcher returned invalid JSON: ${parsed.error.message}` }
    }

    return {
        success: true,
        perModel: parsed.data.perModel,
        sources: parsed.data.sources,
        summary: parsed.data.summary,
    }
}

// Apply one entry of a batched provider response to the registry. Mirrors
// the post-parse logic of researchOneModel — fields normalized, sources
// merged (top-level + per-model, deduped by URL), patch persisted, returns
// the same ResearchSuccess shape for uniform downstream handling.
function applyPerModelPatch(args: {
    providerId: string
    modelId: string
    before: EffectiveModelEntry
    perModel: PerModelResearchResult
    sharedSources?: PerModelResearchResult['sources']
}): ResearchSuccess {
    const sources = mergeResearchSources(args.sharedSources, args.perModel.sources)
    return applyResearchPatch({
        providerId: args.providerId,
        modelId: args.modelId,
        before: args.before,
        fieldsRaw: args.perModel.fields ?? {},
        sources,
        summary: args.perModel.summary,
        unresolved: args.perModel.unresolved,
    })
}

// Shared body of the two patch paths above. Normalizes the AI-returned
// fields, builds and persists the curated patch, then computes whether the
// model is now complete/updated/unchanged and what's still missing.
function applyResearchPatch(args: {
    providerId: string
    modelId: string
    before: EffectiveModelEntry
    fieldsRaw: ResearchFields
    sources?: PerModelResearchResult['sources']
    summary?: string
    unresolved?: UnresolvedField[]
}): ResearchSuccess {
    const now = Date.now()
    const fields = normalizeResearchFields(args.fieldsRaw, args.providerId)
    const patch: CuratedModelEntry = {
        ...fields,
        lastResearchedAt: now,
    }
    if (args.sources && args.sources.length > 0) {
        patch.researchSources = args.sources.map(source => ({
            ...source,
            accessedAt: source.accessedAt ?? now,
        }))
    }

    const cleaned = CuratedModelEntrySchema.parse(stripUndefined(patch))
    const updatedRegistry = patchCuratedModel(args.providerId, args.modelId, cleaned)
    const after = updatedRegistry[args.providerId]?.models[args.modelId] ?? args.before
    const changedFields = changedFieldNames(args.before, after, fields)
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
            summary: args.summary,
            changedFields,
            beforeMissing: args.before.missingFields,
            remainingMissing,
            unresolved: args.unresolved,
        }),
        remainingMissing,
        unresolved: args.unresolved,
        model: after,
    }
}

// Merge shared (top-level) sources with per-model sources, deduped by URL.
// Per-model sources keep precedence so model-specific evidence wins on
// title/publisher when both lists reference the same URL.
function mergeResearchSources(
    shared: PerModelResearchResult['sources'],
    perModel: PerModelResearchResult['sources']
): PerModelResearchResult['sources'] {
    const out: NonNullable<PerModelResearchResult['sources']> = []
    const seen = new Set<string>()
    const push = (list: PerModelResearchResult['sources']) => {
        if (!list) return
        for (const item of list) {
            if (seen.has(item.url)) continue
            seen.add(item.url)
            out.push(item)
        }
    }
    push(perModel)
    push(shared)
    return out.length > 0 ? out : undefined
}
