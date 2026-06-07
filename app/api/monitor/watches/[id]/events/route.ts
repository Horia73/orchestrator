import { NextResponse } from 'next/server'
import { getMonitorWatch, listWatchEvents } from '@/lib/monitor/store'
import { WatchEventKindSchema, type WatchEventKind } from '@/lib/monitor/schema'
import { runWithRequestProfile } from "@/lib/profiles/server"

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return runWithRequestProfile(request, async () => {
        try {
            const { id } = await params
            if (!getMonitorWatch(id)) {
                return NextResponse.json({ error: 'Watch not found' }, { status: 404 })
            }
            const url = new URL(request.url)
            const limitRaw = Number(url.searchParams.get('limit') ?? '100')
            const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, Math.floor(limitRaw))) : 100
            const beforeRaw = Number(url.searchParams.get('before') ?? '')
            const before = Number.isFinite(beforeRaw) && beforeRaw > 0 ? beforeRaw : undefined

            const kindsParam = url.searchParams.get('kinds')
            let kinds: WatchEventKind[] | undefined
            if (kindsParam) {
                const requested = kindsParam.split(',').map((s) => s.trim()).filter(Boolean)
                const parsed: WatchEventKind[] = []
                for (const k of requested) {
                    const ok = WatchEventKindSchema.safeParse(k)
                    if (!ok.success) {
                        return NextResponse.json({ error: `Unknown event kind "${k}".` }, { status: 400 })
                    }
                    parsed.push(ok.data)
                }
                kinds = parsed
            }

            const events = listWatchEvents(id, { limit, before, kinds })
            return NextResponse.json({
                events: events.map((e) => ({
                    id: e.id,
                    ts: e.ts,
                    kind: e.kind,
                    payload: e.payload,
                })),
                hasMore: events.length === limit,
            })
        } catch (error) {
            console.error('Failed to list watch events', error)
            return NextResponse.json({ error: 'Failed to list events' }, { status: 500 })
        }
  })
}
