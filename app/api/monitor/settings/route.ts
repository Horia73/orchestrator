import { NextResponse } from 'next/server'
import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { getConfig, updateConfig, type SmartMonitorQuietHours } from '@/lib/config'

// Smart Monitor app-wide settings. Today just `quietHours`; the field
// matches what `lib/config.ts:SmartMonitorSettings` already validates.

function isValidHHMM(value: unknown): value is string {
    return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
}

export async function GET() {
    try {
        const cfg = getConfig()
        return NextResponse.json({
            settings: cfg.smartMonitor ?? {},
        })
    } catch (error) {
        console.error('Failed to read monitor settings', error)
        return NextResponse.json({ error: 'Failed to read settings' }, { status: 500 })
    }
}

export async function PATCH(request: Request) {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    try {
        const body = await request.json() as { quietHours?: unknown } | null
        const cfg = getConfig()
        const current = cfg.smartMonitor ?? {}

        let nextQuietHours: SmartMonitorQuietHours | undefined = current.quietHours

        // Setting quietHours: validate; setting to null clears.
        if (body && 'quietHours' in body) {
            if (body.quietHours === null) {
                nextQuietHours = undefined
            } else if (
                body.quietHours &&
                typeof body.quietHours === 'object' &&
                !Array.isArray(body.quietHours)
            ) {
                const q = body.quietHours as Record<string, unknown>
                if (!isValidHHMM(q.from)) {
                    return NextResponse.json({ error: 'quietHours.from must be "HH:MM".' }, { status: 400 })
                }
                if (!isValidHHMM(q.to)) {
                    return NextResponse.json({ error: 'quietHours.to must be "HH:MM".' }, { status: 400 })
                }
                if (typeof q.timezone !== 'string' || !q.timezone.trim()) {
                    return NextResponse.json({ error: 'quietHours.timezone is required (IANA name).' }, { status: 400 })
                }
                nextQuietHours = { from: q.from, to: q.to, timezone: q.timezone.trim() }
            } else {
                return NextResponse.json({ error: 'quietHours must be an object or null.' }, { status: 400 })
            }
        }

        const updated = updateConfig({
            smartMonitor: {
                ...current,
                quietHours: nextQuietHours,
            },
        })
        return NextResponse.json({ settings: updated.smartMonitor ?? {} })
    } catch (error) {
        console.error('Failed to update monitor settings', error)
        return NextResponse.json({ error: 'Failed to update settings' }, { status: 500 })
    }
}
