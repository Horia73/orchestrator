import { NextResponse } from 'next/server'
import { getAllCliQuotas, getCliQuota, type CliQuotaId } from '@/lib/cli/usage'
import { runWithRequestProfile } from "@/lib/profiles/server"

const CLI_IDS = new Set<CliQuotaId>(['codex'])

/** GET /api/cli/usage — 5-hour and weekly Codex quota snapshot. */
export async function GET(request: Request) {
  return runWithRequestProfile(request, async () => {
        const url = new URL(request.url)
        const cli = url.searchParams.get('cli')
        if (cli) {
            if (!CLI_IDS.has(cli as CliQuotaId)) {
                return NextResponse.json({ error: 'Unknown CLI.' }, { status: 400 })
            }
            const snapshot = await getCliQuota(cli as CliQuotaId)
            return NextResponse.json({ [cli]: snapshot }, {
                headers: { 'Cache-Control': 'no-store' },
            })
        }

        const snapshots = await getAllCliQuotas()
        return NextResponse.json(snapshots, {
            // Don't let Next.js cache this — both readers are live.
            headers: { 'Cache-Control': 'no-store' },
        })
  })
}
