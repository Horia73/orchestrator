import { NextResponse } from 'next/server'
import { UsageQuerySchema } from '@/lib/observability/schema'
import { buildUsageReport } from '@/lib/observability/store'
import { runWithRequestProfile } from "@/lib/profiles/server"

export async function GET(request: Request) {
  return runWithRequestProfile(request, async () => {
        const url = new URL(request.url)
        const parsed = UsageQuerySchema.safeParse(Object.fromEntries(url.searchParams))
        if (!parsed.success) {
            return NextResponse.json({ error: 'Invalid query', issues: parsed.error.issues }, { status: 400 })
        }
        const report = buildUsageReport(parsed.data.range)
        return NextResponse.json(report)
  })
}
