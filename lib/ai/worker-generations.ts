import fs from 'fs'
import path from 'path'

import { ORCHESTRATOR_STATE_DIR } from '@/lib/runtime-paths'

export const WORKER_GENERATION_PROTOCOL_VERSION = 1

export interface DurableAiWorkerTarget {
    id: string
    service: string
    url: string
    hostPort?: number
    buildCommit?: string | null
}

export interface DurableAiWorkerRegistry {
    protocolVersion: number
    current: DurableAiWorkerTarget
    draining: DurableAiWorkerTarget[]
    backgroundOwner: string | null
    updatedAt: number
}

const WORKER_ID_ENV = 'ORCHESTRATOR_AI_WORKER_ID'
const REGISTRY_PATH_ENV = 'ORCHESTRATOR_AI_WORKER_REGISTRY_PATH'
const LEGACY_WORKER_URL_ENV = 'ORCHESTRATOR_AI_WORKER_URL'

export function durableAiWorkerRegistryPath(): string {
    const configured = process.env[REGISTRY_PATH_ENV]?.trim()
    return configured
        ? path.resolve(configured)
        : path.join(ORCHESTRATOR_STATE_DIR, 'ai-worker-generations.json')
}

export function durableAiWorkerId(): string | null {
    return cleanId(process.env[WORKER_ID_ENV])
}

export function readDurableAiWorkerRegistry(): DurableAiWorkerRegistry | null {
    let parsed: unknown
    try {
        parsed = JSON.parse(fs.readFileSync(durableAiWorkerRegistryPath(), 'utf-8'))
    } catch {
        return null
    }
    if (!parsed || typeof parsed !== 'object') return null
    const raw = parsed as Record<string, unknown>
    const current = parseTarget(raw.current)
    if (!current) return null
    const draining = Array.isArray(raw.draining)
        ? raw.draining.map(parseTarget).filter((target): target is DurableAiWorkerTarget => Boolean(target))
        : []
    const dedupedDraining = draining.filter(
        (target, index) => target.id !== current.id && draining.findIndex(candidate => candidate.id === target.id) === index,
    )
    const protocolVersion = integer(raw.protocolVersion) ?? WORKER_GENERATION_PROTOCOL_VERSION
    if (protocolVersion < 1) return null
    const backgroundOwner = raw.backgroundOwner === null
        ? null
        : cleanId(raw.backgroundOwner)
    return {
        protocolVersion,
        current,
        draining: dedupedDraining,
        backgroundOwner,
        updatedAt: integer(raw.updatedAt) ?? 0,
    }
}

/** Current admission target plus every generation that still owns accepted
 * work. The registry is written atomically by the host bridge, so each caller
 * observes either the complete pre-cutover or post-cutover fleet. */
export function listDurableAiWorkerTargets(): DurableAiWorkerTarget[] {
    const registry = readDurableAiWorkerRegistry()
    if (registry) return [registry.current, ...registry.draining]
    const fallback = legacyWorkerTarget()
    return fallback ? [fallback] : []
}

export function currentDurableAiWorkerTarget(): DurableAiWorkerTarget | null {
    return readDurableAiWorkerRegistry()?.current ?? legacyWorkerTarget()
}

/** Background machinery deliberately has a separate owner from interactive
 * admission. During a blue/green overlap the bridge sets this to null: new
 * user work proceeds on the new generation while schedulers pause instead of
 * racing recovery against runs still finishing on the old generation. */
export function mayOwnDurableAiBackgroundWork(): boolean {
    const workerId = durableAiWorkerId()
    if (!workerId) return true
    const registry = readDurableAiWorkerRegistry()
    if (!registry) return workerId === 'blue' || workerId === 'legacy'
    return registry.backgroundOwner === workerId
}

export function durableAiFleetHasOverlap(): boolean {
    return (readDurableAiWorkerRegistry()?.draining.length ?? 0) > 0
}

function legacyWorkerTarget(): DurableAiWorkerTarget | null {
    const raw = process.env[LEGACY_WORKER_URL_ENV]?.trim()
    const url = cleanUrl(raw)
    if (!url) return null
    return {
        id: durableAiWorkerId() ?? 'legacy',
        service: 'ai-worker',
        url,
    }
}

function parseTarget(value: unknown): DurableAiWorkerTarget | null {
    if (!value || typeof value !== 'object') return null
    const raw = value as Record<string, unknown>
    const id = cleanId(raw.id)
    const service = cleanService(raw.service)
    const url = cleanUrl(raw.url)
    if (!id || !service || !url) return null
    return {
        id,
        service,
        url,
        hostPort: integer(raw.hostPort) ?? undefined,
        buildCommit: typeof raw.buildCommit === 'string' ? raw.buildCommit : null,
    }
}

function cleanId(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    return /^[a-z0-9][a-z0-9_-]{0,31}$/i.test(trimmed) ? trimmed : null
}

function cleanService(value: unknown): string | null {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    return /^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(trimmed) ? trimmed : null
}

function cleanUrl(value: unknown): string | null {
    if (typeof value !== 'string' || !value.trim()) return null
    try {
        const url = new URL(value.trim())
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
        return url.toString().replace(/\/$/, '')
    } catch {
        return null
    }
}

function integer(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}
