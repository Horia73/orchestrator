import type { NormalizedAddressComponent } from '@/lib/maps/google-geocoding'

export function cleanAddressPart(part: string): string {
    return part
        .replace(/^\d{3,}(?:[-\s]\d+)?\s+/, '')
        .replace(/\s+\d{3,}(?:[-\s]\d+)?(?:\s.*)?$/, '')
        .trim()
}

export function splitFormattedAddress(formatted: string): { region?: string; country?: string } {
    const parts = formatted.split(',').map(p => p.trim()).filter(Boolean)
    if (parts.length === 0) return {}
    const country = parts[parts.length - 1]
    const region = parts.length >= 2 ? cleanAddressPart(parts[parts.length - 2]) : undefined
    return { region, country }
}

export function pickShortName(formatted: string, fallback: string): string {
    const parts = formatted.split(',').map(p => p.trim()).filter(Boolean)
    if (parts.length === 0) return fallback
    if (parts.length >= 3) {
        const candidate = cleanAddressPart(parts[parts.length - 2])
        if (/^[A-Z]{2,3}$/.test(candidate) && parts.length >= 4) {
            return cleanAddressPart(parts[parts.length - 3]) || fallback
        }
        return candidate || fallback
    }
    return cleanAddressPart(parts[0]) || fallback
}

function findAddressComponent(
    components: NormalizedAddressComponent[] | undefined,
    types: string[],
): NormalizedAddressComponent | undefined {
    if (!components?.length) return undefined
    for (const type of types) {
        const component = components.find(candidate => candidate.types.includes(type))
        if (component) return component
    }
    return undefined
}

export function pickLocalityName(components: NormalizedAddressComponent[] | undefined): string | undefined {
    return findAddressComponent(components, [
        'locality',
        'postal_town',
        'administrative_area_level_3',
        'administrative_area_level_2',
    ])?.longName
}

export function pickRegionName(components: NormalizedAddressComponent[] | undefined): string | undefined {
    return findAddressComponent(components, [
        'administrative_area_level_1',
        'administrative_area_level_2',
    ])?.longName
}

export function pickCountryName(components: NormalizedAddressComponent[] | undefined): string | undefined {
    return findAddressComponent(components, ['country'])?.longName
}

export function coordinateLabel(lat: number, lng: number): string {
    return `${lat.toFixed(4)}, ${lng.toFixed(4)}`
}
