import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { getPlaceDetails } from '@/lib/maps/google-places'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(
    request: Request,
    { params }: { params: Promise<{ placeId: string }> },
) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    const { placeId } = await params
    const cleanPlaceId = decodeURIComponent(placeId ?? '').trim()
    if (!cleanPlaceId) {
        return NextResponse.json({ error: 'Missing place id.' }, { status: 400, headers: NO_STORE })
    }

    const url = new URL(request.url)
    try {
        const place = await getPlaceDetails(cleanPlaceId, {
            languageCode: cleanParam(url.searchParams.get('language')),
            regionCode: cleanParam(url.searchParams.get('region')),
        })

        return NextResponse.json({
            place: {
                id: place.id,
                title: place.displayName,
                address: place.shortFormattedAddress ?? place.formattedAddress,
                position: place.position,
                rating: place.rating,
                userRatingCount: place.userRatingCount,
                photoUrl: place.photoUrl,
                googleMapsUri: place.googleMapsUri,
                websiteUri: place.websiteUri,
                businessStatus: place.businessStatus,
                openNow:
                    place.currentOpeningHours?.openNow ??
                    place.regularOpeningHours?.openNow ??
                    null,
                openingHours:
                    place.currentOpeningHours?.weekdayDescriptions.length
                        ? place.currentOpeningHours.weekdayDescriptions
                        : place.regularOpeningHours?.weekdayDescriptions.length
                            ? place.regularOpeningHours.weekdayDescriptions
                            : [],
                phoneNumber: place.phoneNumber,
                priceLevel: place.priceLevel,
                editorialSummary: place.editorialSummary,
                provider: 'google-places',
            },
        }, { headers: NO_STORE })
    } catch (err) {
        return NextResponse.json(
            { error: err instanceof Error ? err.message : 'Place details failed.' },
            { status: 502, headers: NO_STORE },
        )
    }
}

function cleanParam(value: string | null): string | undefined {
    const trimmed = value?.trim()
    return trimmed || undefined
}
