import { NextResponse } from 'next/server'

import { runWithRequestProfile } from "@/lib/profiles/server"
import {
    appendBodyMetric,
    computeBmi,
    readBodyMetrics,
} from '@/lib/workout/body-metrics'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  return runWithRequestProfile(request, async () => {
        const url = new URL(request.url)
        const limit = clampInt(url.searchParams.get('limit'), 30, 1, 200)
        const entries = readBodyMetrics(limit)
        const latest = entries[0] ?? null
        return NextResponse.json({
            entries,
            latest,
            bmi: latest ? computeBmi(latest.weightKg, latest.heightCm) : null,
            count: entries.length,
        })
  })
}

export async function POST(request: Request) {
  return runWithRequestProfile(request, async () => {
        let body: Record<string, unknown>
        try {
            body = await request.json() as Record<string, unknown>
        } catch {
            return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
        }

        const recordedAt = stringValue(body.recordedAt) ?? new Date().toISOString()
        const heightCm = numberValue(body.heightCm, 80, 260)
        const weightKg = numberValue(body.weightKg, 20, 400)
        const bodyFatPct = numberValue(body.bodyFatPct, 1, 80)
        const muscleMassKg = numberValue(body.muscleMassKg, 1, 250)
        const notes = stringValue(body.notes)?.slice(0, 300)

        if (!heightCm && !weightKg && !bodyFatPct && !muscleMassKg && !notes) {
            return NextResponse.json(
                { error: 'Provide at least one metric: heightCm, weightKg, bodyFatPct, muscleMassKg, or notes.' },
                { status: 400 },
            )
        }

        const entry = appendBodyMetric({
            recordedAt,
            heightCm,
            weightKg,
            bodyFatPct,
            muscleMassKg,
            notes,
        })

        return NextResponse.json({
            ok: true,
            entry,
            bmi: computeBmi(entry.weightKg, entry.heightCm),
        })
  })
}

function numberValue(value: unknown, min: number, max: number): number | undefined {
    if (value === null || value === undefined || value === '') return undefined
    const n = typeof value === 'number' ? value : Number.parseFloat(String(value))
    if (!Number.isFinite(n)) return undefined
    return Math.min(max, Math.max(min, Math.round(n * 10) / 10))
}

function stringValue(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    return trimmed || undefined
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
    if (raw === null) return fallback
    const n = Number.parseInt(raw, 10)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, n))
}
