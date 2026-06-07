import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'

import { workoutsDir } from './storage'

export interface BodyMetricEntry {
    id: string
    recordedAt: string
    heightCm?: number
    weightKg?: number
    bodyFatPct?: number
    /** Skeletal-muscle percentage of bodyweight, mirroring how smart scales report it (and `bodyFatPct`). */
    musclePct?: number
    notes?: string
}

interface BodyMetricStore {
    v: 1
    entries: BodyMetricEntry[]
}

export function bodyMetricsPath(): string {
    return path.join(workoutsDir(), 'body-metrics.json')
}

function ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function writeAtomic(filePath: string, contents: string): void {
    ensureDir(path.dirname(filePath))
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
    fs.writeFileSync(tmp, contents, 'utf8')
    fs.renameSync(tmp, filePath)
}

export function readBodyMetrics(limit = 100): BodyMetricEntry[] {
    try {
        const filePath = bodyMetricsPath()
        if (!fs.existsSync(filePath)) return []
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<BodyMetricStore>
        const entries = Array.isArray(parsed.entries) ? parsed.entries : []
        return entries
            .filter(isBodyMetricEntry)
            .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
            .slice(0, Math.max(1, Math.min(500, limit)))
    } catch {
        return []
    }
}

export function appendBodyMetric(input: Omit<BodyMetricEntry, 'id'>): BodyMetricEntry {
    const existing = readBodyMetrics(500)
    const entry: BodyMetricEntry = {
        id: randomUUID(),
        recordedAt: input.recordedAt,
        heightCm: input.heightCm,
        weightKg: input.weightKg,
        bodyFatPct: input.bodyFatPct,
        musclePct: input.musclePct,
        notes: input.notes,
    }
    const next: BodyMetricStore = {
        v: 1,
        entries: [entry, ...existing].slice(0, 500),
    }
    writeAtomic(bodyMetricsPath(), JSON.stringify(next, null, 2))
    return entry
}

export function latestBodyMetric(): BodyMetricEntry | null {
    return readBodyMetrics(1)[0] ?? null
}

export function computeBmi(weightKg: number | undefined, heightCm: number | undefined): number | null {
    if (!weightKg || !heightCm) return null
    const meters = heightCm / 100
    if (meters <= 0) return null
    return Math.round((weightKg / (meters * meters)) * 10) / 10
}

function isBodyMetricEntry(value: unknown): value is BodyMetricEntry {
    if (!value || typeof value !== 'object') return false
    const entry = value as Partial<BodyMetricEntry>
    return typeof entry.id === 'string' && typeof entry.recordedAt === 'string'
}
