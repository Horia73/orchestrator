import type { MapBBox, MapCoordinate } from './schema'

export interface RouteOptimizerStop {
    id?: string
    label?: string
    position: MapCoordinate
}

export interface RouteOptimizerOptions {
    start?: MapCoordinate
    startLabel?: string
    end?: MapCoordinate
    endLabel?: string
    returnToStart?: boolean
    preserveFirstStop?: boolean
}

export interface OptimizedStop extends RouteOptimizerStop {
    originalIndex: number
    order: number
    distanceFromPreviousMeters: number | null
    cumulativeDistanceMeters: number
}

export interface OptimizedWaypoint {
    kind: 'start' | 'stop' | 'end'
    order: number
    position: MapCoordinate
    label?: string
    id?: string
    originalIndex?: number
    distanceFromPreviousMeters: number | null
    cumulativeDistanceMeters: number
}

export interface OptimizedStopsResult {
    orderedStops: OptimizedStop[]
    stopOrder: number[]
    waypoints: OptimizedWaypoint[]
    waypointPositions: MapCoordinate[]
    distanceMetersApprox: number
    distanceTextApprox: string
    fitBounds: MapBBox
    strategy: 'nearest-neighbor-2opt'
    warnings: string[]
}

interface IndexedStop extends RouteOptimizerStop {
    originalIndex: number
}

export function optimizeStopOrder(
    stops: RouteOptimizerStop[],
    options: RouteOptimizerOptions = {},
): OptimizedStopsResult {
    const indexedStops: IndexedStop[] = stops.map((stop, index) => ({
        ...stop,
        originalIndex: index,
    }))
    const preserveFirstStop = options.preserveFirstStop === true && indexedStops.length > 0
    const leadingStop = !options.start && preserveFirstStop ? indexedStops[0] : null
    const reorderable = leadingStop
        ? indexedStops.slice(1)
        : indexedStops

    const fixedStart = options.start ?? leadingStop?.position
    const fixedEnd = options.end
        ?? (options.returnToStart && options.start ? options.start : undefined)
        ?? (options.returnToStart && leadingStop ? leadingStop.position : undefined)
    const closeCycle = options.returnToStart === true && !fixedEnd

    const optimizedRemainder = optimizeIndexedStops(reorderable, fixedStart, fixedEnd, closeCycle)
    const ordered = leadingStop ? [leadingStop, ...optimizedRemainder] : optimizedRemainder
    const waypoints = buildWaypoints(ordered, options)
    const waypointPositions = waypoints.map(waypoint => waypoint.position)
    const distanceMetersApprox = waypoints.length >= 2
        ? waypoints.slice(1).reduce((sum, waypoint) => sum + (waypoint.distanceFromPreviousMeters ?? 0), 0)
        : 0

    const orderedStops = waypoints
        .filter((waypoint): waypoint is OptimizedWaypoint & { kind: 'stop'; originalIndex: number } => (
            waypoint.kind === 'stop' && typeof waypoint.originalIndex === 'number'
        ))
        .map((waypoint, index): OptimizedStop => {
            const stop = indexedStops[waypoint.originalIndex]
            return {
                id: stop.id,
                label: stop.label,
                position: stop.position,
                originalIndex: stop.originalIndex,
                order: index + 1,
                distanceFromPreviousMeters: waypoint.distanceFromPreviousMeters,
                cumulativeDistanceMeters: waypoint.cumulativeDistanceMeters,
            }
        })

    return {
        orderedStops,
        stopOrder: orderedStops.map(stop => stop.originalIndex),
        waypoints,
        waypointPositions,
        distanceMetersApprox,
        distanceTextApprox: formatDistance(distanceMetersApprox),
        fitBounds: bboxForCoordinates(waypointPositions),
        strategy: 'nearest-neighbor-2opt',
        warnings: [
            'Order is optimized with straight-line distance, not live traffic. Use MapsDirections on waypointPositions for real route geometry and ETA.',
        ],
    }
}

function optimizeIndexedStops(
    stops: IndexedStop[],
    fixedStart: MapCoordinate | undefined,
    fixedEnd: MapCoordinate | undefined,
    closeCycle: boolean,
): IndexedStop[] {
    if (stops.length <= 1) return stops

    const seedOrders = fixedStart
        ? [nearestNeighbor(stops, fixedStart)]
        : stops.map(stop => nearestNeighbor(stops, stop.position, stop.originalIndex))

    let best = seedOrders[0]
    let bestCost = routeCost(best, fixedStart, fixedEnd, closeCycle)
    for (const seed of seedOrders) {
        const improved = twoOpt(seed, fixedStart, fixedEnd, closeCycle)
        const cost = routeCost(improved, fixedStart, fixedEnd, closeCycle)
        if (cost < bestCost) {
            best = improved
            bestCost = cost
        }
    }
    return best
}

function nearestNeighbor(
    stops: IndexedStop[],
    start: MapCoordinate,
    seedOriginalIndex?: number,
): IndexedStop[] {
    const remaining = new Map(stops.map(stop => [stop.originalIndex, stop]))
    const order: IndexedStop[] = []
    let cursor = start

    if (typeof seedOriginalIndex === 'number') {
        const seed = remaining.get(seedOriginalIndex)
        if (seed) {
            order.push(seed)
            remaining.delete(seedOriginalIndex)
            cursor = seed.position
        }
    }

    while (remaining.size > 0) {
        let best: IndexedStop | null = null
        let bestDistance = Number.POSITIVE_INFINITY
        for (const stop of remaining.values()) {
            const distance = haversineMeters(cursor, stop.position)
            if (distance < bestDistance) {
                best = stop
                bestDistance = distance
            }
        }
        if (!best) break
        order.push(best)
        remaining.delete(best.originalIndex)
        cursor = best.position
    }

    return order
}

function twoOpt(
    initial: IndexedStop[],
    fixedStart: MapCoordinate | undefined,
    fixedEnd: MapCoordinate | undefined,
    closeCycle: boolean,
): IndexedStop[] {
    let route = [...initial]
    let improved = true
    let guard = 0

    while (improved && guard < 100) {
        improved = false
        guard++
        const baseCost = routeCost(route, fixedStart, fixedEnd, closeCycle)

        for (let i = 0; i < route.length - 1; i++) {
            for (let k = i + 1; k < route.length; k++) {
                const candidate = [
                    ...route.slice(0, i),
                    ...route.slice(i, k + 1).reverse(),
                    ...route.slice(k + 1),
                ]
                const candidateCost = routeCost(candidate, fixedStart, fixedEnd, closeCycle)
                if (candidateCost + 0.001 < baseCost) {
                    route = candidate
                    improved = true
                    break
                }
            }
            if (improved) break
        }
    }

    return route
}

function routeCost(
    stops: IndexedStop[],
    fixedStart: MapCoordinate | undefined,
    fixedEnd: MapCoordinate | undefined,
    closeCycle: boolean,
): number {
    if (stops.length === 0) return fixedStart && fixedEnd ? haversineMeters(fixedStart, fixedEnd) : 0
    let distance = 0
    let previous = fixedStart ?? stops[0].position
    const startIndex = fixedStart ? 0 : 1
    for (let i = startIndex; i < stops.length; i++) {
        distance += haversineMeters(previous, stops[i].position)
        previous = stops[i].position
    }
    if (fixedEnd) distance += haversineMeters(previous, fixedEnd)
    else if (closeCycle) distance += haversineMeters(previous, fixedStart ?? stops[0].position)
    return distance
}

function buildWaypoints(
    stops: IndexedStop[],
    options: RouteOptimizerOptions,
): OptimizedWaypoint[] {
    const waypoints: Array<Omit<OptimizedWaypoint, 'order' | 'distanceFromPreviousMeters' | 'cumulativeDistanceMeters'>> = []

    if (options.start) {
        waypoints.push({
            kind: 'start',
            position: options.start,
            label: options.startLabel ?? 'Start',
        })
    }

    for (const stop of stops) {
        waypoints.push({
            kind: 'stop',
            position: stop.position,
            label: stop.label,
            id: stop.id,
            originalIndex: stop.originalIndex,
        })
    }

    if (options.end) {
        waypoints.push({
            kind: 'end',
            position: options.end,
            label: options.endLabel ?? 'End',
        })
    } else if (options.returnToStart === true) {
        const start = options.start
            ? { position: options.start, label: options.startLabel ?? 'Start' }
            : stops[0]
                ? { position: stops[0].position, label: stops[0].label ?? 'Start' }
                : null
        if (start) {
            waypoints.push({
                kind: 'end',
                position: start.position,
                label: `Return to ${start.label}`,
            })
        }
    }

    let cumulative = 0
    return waypoints.map((waypoint, index): OptimizedWaypoint => {
        const distanceFromPreviousMeters = index === 0
            ? null
            : Math.round(haversineMeters(waypoints[index - 1].position, waypoint.position))
        if (distanceFromPreviousMeters !== null) cumulative += distanceFromPreviousMeters
        return {
            ...waypoint,
            order: index,
            distanceFromPreviousMeters,
            cumulativeDistanceMeters: cumulative,
        }
    })
}

function bboxForCoordinates(coords: MapCoordinate[]): MapBBox {
    if (coords.length === 0) return [0, 0, 0, 0]
    let west = coords[0][0]
    let east = coords[0][0]
    let south = coords[0][1]
    let north = coords[0][1]
    for (const [lng, lat] of coords) {
        west = Math.min(west, lng)
        east = Math.max(east, lng)
        south = Math.min(south, lat)
        north = Math.max(north, lat)
    }
    return [west, south, east, north]
}

function haversineMeters(a: MapCoordinate, b: MapCoordinate): number {
    const radius = 6_371_000
    const lat1 = toRad(a[1])
    const lat2 = toRad(b[1])
    const dLat = toRad(b[1] - a[1])
    const dLng = toRad(b[0] - a[0])
    const sinLat = Math.sin(dLat / 2)
    const sinLng = Math.sin(dLng / 2)
    const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng
    return radius * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}

function toRad(value: number): number {
    return value * Math.PI / 180
}

function formatDistance(meters: number): string {
    if (meters < 1000) return `${Math.round(meters)} m`
    return `${(meters / 1000).toFixed(meters < 10_000 ? 1 : 0)} km`
}
