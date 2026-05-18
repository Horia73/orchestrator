import { NextResponse } from 'next/server'
import { getAllCliStatuses } from '@/lib/cli/status'
import { CLI_SPECS, getCliLoginHint } from '@/lib/cli/specs'

/** GET /api/cli/status — installed + loggedIn for each CLI. */
export async function GET() {
    const statuses = await getAllCliStatuses({ force: true })
    // Include spec metadata so the UI can render names/descriptions without
    // duplicating the registry on the client side.
    const enriched = Object.fromEntries(
        Object.entries(statuses).map(([id, status]) => [
            id,
            {
                ...status,
                name: CLI_SPECS[id as keyof typeof CLI_SPECS].name,
                description: CLI_SPECS[id as keyof typeof CLI_SPECS].description,
                bin: CLI_SPECS[id as keyof typeof CLI_SPECS].bin,
                installHint: CLI_SPECS[id as keyof typeof CLI_SPECS].installHint,
                installDocsUrl: CLI_SPECS[id as keyof typeof CLI_SPECS].installDocsUrl,
                loginHint: getCliLoginHint(id as keyof typeof CLI_SPECS),
            },
        ])
    )
    return NextResponse.json(enriched)
}
