import { NextResponse } from 'next/server'

import { executeWeatherShow } from '@/lib/ai/tools/weather'
import { getArtifactById, insertArtifact } from '@/lib/artifacts/store'
import { parseWeatherArtifact } from '@/lib/weather/schema'

/**
 * POST /api/artifacts/:id/refresh-weather
 *
 * Server-side refresh for a weather artifact. Loads the existing artifact,
 * extracts the location + units from its body, re-runs `WeatherShow` with
 * `refresh: true`, and inserts a new artifact version (same identifier,
 * same conversation, same parent message — only `version` increments).
 *
 * Returns the new ArtifactRow. The client mutates the local
 * `useConversationArtifacts` store with it, which triggers
 * `RenderMessageContent` to render the latest version in place of the old
 * card. No model turn, no chat round-trip.
 */
export async function POST(
    _request: Request,
    { params }: { params: Promise<{ id: string }> },
) {
    const { id } = await params

    const existing = getArtifactById(id)
    if (!existing) {
        return NextResponse.json({ error: 'Artifact not found' }, { status: 404 })
    }
    if (existing.type !== 'application/vnd.ant.weather') {
        return NextResponse.json(
            { error: `Refresh only supported for weather artifacts (got "${existing.type}")` },
            { status: 400 },
        )
    }

    // Pull location + units out of the existing body so the refresh re-asks
    // for the same place at the same scale. If the body is corrupt we bail
    // — better to surface the parse error than silently fetch the wrong
    // location.
    const parsed = parseWeatherArtifact(existing.content)
    if (!parsed.ok) {
        return NextResponse.json(
            { error: `Stored artifact body did not parse: ${parsed.error}` },
            { status: 500 },
        )
    }

    // Prefer the coordinate pair — bypasses geocoding entirely and is
    // resilient to place-name ambiguity.
    const [lng, lat] = parsed.value.location.coordinates
    const locationArg = `${lat},${lng}`
    const dayCount = Math.max(1, Math.min(10, parsed.value.daily.length || 10))

    const result = await executeWeatherShow({
        location: locationArg,
        units: parsed.value.units,
        days: dayCount,
        refresh: true,
        // Keep the same identifier so the new row stays inside the same
        // version chain. WeatherShow re-derives a kebab-case slug from
        // the location name when identifier is absent; passing it
        // explicitly avoids the renamed-version pitfall.
        identifier: existing.identifier,
        title: existing.title,
        attribution: parsed.value.attribution,
    })

    if (!result.success || !result.data || typeof result.data !== 'object') {
        return NextResponse.json(
            { error: result.error ?? 'WeatherShow returned no data' },
            { status: 502 },
        )
    }
    const data = result.data as Record<string, unknown>
    const body = typeof data.body === 'string' ? data.body : null
    if (!body) {
        return NextResponse.json({ error: 'WeatherShow returned no body' }, { status: 502 })
    }
    const refreshed = parseWeatherArtifact(body)
    if (!refreshed.ok) {
        return NextResponse.json(
            { error: `Refreshed weather artifact did not parse: ${refreshed.error}` },
            { status: 502 },
        )
    }

    // Refresh by coordinates avoids geocoding ambiguity, but when Google
    // reverse geocoding is unavailable WeatherShow can only label the location
    // as "lat,lng". Preserve the original human label while keeping the newly
    // fetched provider timezone and forecast values.
    const refreshedBody = JSON.stringify({
        ...refreshed.value,
        location: {
            ...refreshed.value.location,
            name: parsed.value.location.name,
            region: parsed.value.location.region,
            country: parsed.value.location.country,
            timezone: refreshed.value.location.timezone || parsed.value.location.timezone,
        },
    })

    // Insert a fresh version under the same conversation + message. The
    // store's atomic version bump handles concurrent refreshes correctly.
    const row = insertArtifact({
        conversationId: existing.conversationId,
        messageId: existing.messageId,
        identifier: existing.identifier,
        type: 'application/vnd.ant.weather',
        title: existing.title,
        language: null,
        display: existing.display ?? 'inline',
        content: refreshedBody,
    })

    return NextResponse.json(row)
}
