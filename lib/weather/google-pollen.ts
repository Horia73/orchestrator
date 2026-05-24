import { readGoogleMapsApiKey } from '@/lib/maps/google-session'

import type { WeatherPollen, WeatherPollenSpecies } from './schema'

// ---------------------------------------------------------------------------
// Google Pollen API client.
//
// Endpoint:
//   GET https://pollen.googleapis.com/v1/forecast:lookup
//     ?location.latitude=LAT&location.longitude=LNG&days=1&key=...
//
// Uses `GOOGLE_MAPS_API_KEY`, but the **Pollen API** must be separately
// enabled in the GCP project at:
//   https://console.cloud.google.com/apis/library/pollen.googleapis.com
//
// Google returns Universal Pollen Index (UPI) values on a 0-5 scale for
// pollen types (TREE, GRASS, WEED) plus optional plant-level details. The
// weather card only needs a compact current tile, so we normalize the pollen
// type index into the existing WeatherPollen shape.
// ---------------------------------------------------------------------------

const POLLEN_BASE = 'https://pollen.googleapis.com/v1/forecast:lookup'

interface GooglePollenResponse {
    dailyInfo?: Array<{
        pollenTypeInfo?: Array<{
            code?: string
            displayName?: string
            inSeason?: boolean
            indexInfo?: {
                value?: number
                category?: string
                indexDescription?: string
            }
            healthRecommendations?: string[]
        }>
    }>
}

export interface FetchGooglePollenOptions {
    lat: number
    lng: number
    languageCode?: string
}

export class GooglePollenError extends Error {
    constructor(message: string, public readonly status?: number, public readonly upstream?: string) {
        super(message)
        this.name = 'GooglePollenError'
    }
}

export async function fetchGooglePollen(opts: FetchGooglePollenOptions): Promise<WeatherPollen | null> {
    const apiKey = readGoogleMapsApiKey()
    if (!apiKey) throw new GooglePollenError('GOOGLE_MAPS_API_KEY is not set')

    const url = new URL(POLLEN_BASE)
    url.searchParams.set('key', apiKey)
    url.searchParams.set('location.latitude', String(opts.lat))
    url.searchParams.set('location.longitude', String(opts.lng))
    url.searchParams.set('days', '1')
    url.searchParams.set('plantsDescription', 'false')
    if (opts.languageCode) url.searchParams.set('languageCode', opts.languageCode)

    let resp: Response
    try {
        resp = await fetch(url.toString())
    } catch (e) {
        throw new GooglePollenError(`network: ${(e as Error).message}`)
    }
    if (!resp.ok) {
        let text = ''
        try { text = await resp.text() } catch { /* ignore */ }
        throw new GooglePollenError(
            `Google Pollen API HTTP ${resp.status}`,
            resp.status,
            text || undefined,
        )
    }

    let data: GooglePollenResponse
    try {
        data = await resp.json() as GooglePollenResponse
    } catch (e) {
        throw new GooglePollenError(`bad json: ${(e as Error).message}`)
    }

    const pollenTypes = data.dailyInfo?.[0]?.pollenTypeInfo ?? []
    const species: WeatherPollenSpecies[] = []
    const recommendations: string[] = []

    for (const item of pollenTypes) {
        const kind = googlePollenKind(item.code)
        const value = item.indexInfo?.value
        if (!kind || typeof value !== 'number' || !Number.isFinite(value)) continue
        species.push({
            kind,
            label: item.displayName?.trim() || defaultGooglePollenLabel(kind),
            value: round1(value),
            level: googlePollenLevel(value),
        })
        for (const rec of item.healthRecommendations ?? []) {
            if (rec.trim()) recommendations.push(rec.trim())
        }
    }

    if (species.length === 0) return null
    species.sort((a, b) => b.value - a.value)
    const primary = species[0]
    const recommendation = recommendations[0]
    return {
        source: 'google-pollen',
        generatedAt: new Date().toISOString(),
        primary,
        species,
        summary: recommendation
            ? truncate(recommendation, 178)
            : `${primary.label} is the main Google Pollen signal right now (${primary.level.replace('_', ' ')}).`,
    }
}

function googlePollenKind(code: string | undefined): WeatherPollenSpecies['kind'] | null {
    switch ((code ?? '').toUpperCase()) {
        case 'TREE': return 'tree'
        case 'GRASS': return 'grass'
        case 'WEED': return 'weed'
        default: return null
    }
}

function defaultGooglePollenLabel(kind: WeatherPollenSpecies['kind']): string {
    switch (kind) {
        case 'tree': return 'Tree'
        case 'weed': return 'Weed'
        default: return kind.charAt(0).toUpperCase() + kind.slice(1)
    }
}

function googlePollenLevel(value: number): WeatherPollenSpecies['level'] {
    if (value >= 5) return 'very_high'
    if (value >= 4) return 'high'
    if (value >= 2) return 'moderate'
    return 'low'
}

function round1(n: number): number {
    return Math.round(n * 10) / 10
}

function truncate(value: string, max: number): string {
    return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`
}
