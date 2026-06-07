import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { factoryResetAppData, isFactoryResetScope, type FactoryResetScope } from '@/lib/settings/factory-reset'
import { runWithRequestProfile } from "@/lib/profiles/server"

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  return runWithRequestProfile(request, async () => {
        const guard = guardSensitiveRequest(request)
        if (guard) return guard

        let body: unknown
        try {
            body = await request.json()
        } catch {
            body = {}
        }

        const confirm = body && typeof body === 'object' && 'confirm' in body
            ? (body as { confirm?: unknown }).confirm
            : null
        if (confirm !== 'factory-reset') {
            return NextResponse.json(
                { error: 'Missing factory reset confirmation.' },
                { status: 400, headers: { 'Cache-Control': 'no-store' } }
            )
        }

        const preserveEnvLocal = body && typeof body === 'object' && 'preserveEnvLocal' in body
            ? (body as { preserveEnvLocal?: unknown }).preserveEnvLocal !== false
            : true
        const scopes = body && typeof body === 'object' && 'scopes' in body
            ? parseScopes((body as { scopes?: unknown }).scopes)
            : undefined

        if (Array.isArray(scopes) && scopes.length === 0) {
            return NextResponse.json(
                { error: 'Select at least one reset scope.' },
                { status: 400, headers: { 'Cache-Control': 'no-store' } }
            )
        }

        try {
            const result = factoryResetAppData({ preserveEnvLocal, scopes })
            return NextResponse.json(
                { success: true, ...result },
                { headers: { 'Cache-Control': 'no-store' } }
            )
        } catch (err) {
            return NextResponse.json(
                { error: err instanceof Error ? err.message : 'Factory reset failed.' },
                { status: 500, headers: { 'Cache-Control': 'no-store' } }
            )
        }
  })
}

function parseScopes(value: unknown): FactoryResetScope[] | undefined {
    if (value === undefined) return undefined
    if (!Array.isArray(value)) return []
    return value.filter(isFactoryResetScope)
}
