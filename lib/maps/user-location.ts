import fs from 'fs'
import path from 'path'

import { activeRuntimePaths } from '@/lib/runtime-paths'
import type { MapCoordinate } from '@/lib/maps/schema'

export interface UserMapLocation {
    label: string
    position: MapCoordinate
    fallbackReason?: string
}

function userFilePath(): string {
    return path.join(/* turbopackIgnore: true */ activeRuntimePaths().workspaceDir, 'USER.md')
}

const KNOWN_LOCATION_COORDS: Array<{ match: RegExp; label: string; position: MapCoordinate }> = [
    { match: /\bcluj(?:-|\s)?napoca\b|\bcluj\b/i, label: 'Cluj-Napoca', position: [23.5894, 46.7712] },
    { match: /\bbucuresti\b|\bbucurești\b|\bbucharest\b/i, label: 'Bucuresti', position: [26.1025, 44.4268] },
]
const DEFAULT_LOCATION = KNOWN_LOCATION_COORDS[0]

export function getUserMapLocation(): UserMapLocation {
    const locationText = readUserLocation()
    if (locationText) {
        for (const known of KNOWN_LOCATION_COORDS) {
            if (known.match.test(locationText)) {
                return { label: known.label, position: known.position }
            }
        }
        return {
            label: DEFAULT_LOCATION.label,
            position: DEFAULT_LOCATION.position,
            fallbackReason: `Profile location "${locationText}" is not recognized yet; using ${DEFAULT_LOCATION.label} as the default map center.`,
        }
    }
    return { label: DEFAULT_LOCATION.label, position: DEFAULT_LOCATION.position }
}

function readUserLocation(): string | null {
    try {
        const raw = fs.readFileSync(/* turbopackIgnore: true */ userFilePath(), 'utf8')
        const match = raw.match(/^\s*-\s*Location:\s*(.+?)\s*$/im)
        return match?.[1]?.trim() || null
    } catch {
        return null
    }
}
