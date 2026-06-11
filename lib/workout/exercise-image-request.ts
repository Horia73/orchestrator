// Client-safe builder for the exercise demo-image lookup URL.
//
// Shared by the exercise info panel (which fetches on open) and the surface
// prefetcher (which warms the browser cache on idle). They MUST build the exact
// same URL or the prefetched image won't satisfy the panel's request — hence
// this single source of truth. No server imports; just string assembly.

export interface WorkoutImageRequestInput {
    id: string
    name: string
    muscleGroups?: readonly string[]
    equipment?: readonly string[]
    imageQuery?: string
}

export function workoutImageRequestPath(input: WorkoutImageRequestInput): string {
    const params = new URLSearchParams()
    if (input.id) params.set('id', input.id)
    if (input.name) params.set('name', input.name)
    const muscle = (input.muscleGroups ?? []).slice(0, 4).join(',')
    if (muscle) params.set('muscle', muscle)
    const equip = (input.equipment ?? []).slice(0, 4).join(',')
    if (equip) params.set('equipment', equip)
    const explicit = input.imageQuery?.trim()
    params.set('q', explicit || `${input.name} exercise gym machine`)
    params.set('limit', '1')
    return `/api/workout-images?${params.toString()}`
}
