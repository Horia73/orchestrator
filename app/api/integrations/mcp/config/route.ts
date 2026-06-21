import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { saveRemoteMcpServer } from '@/lib/integrations/mcp'
import { runWithRequestProfile } from '@/lib/profiles/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function PUT(request: Request) {
  return runWithRequestProfile(request, async () => {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    try {
      const body = await request.json().catch(() => ({}))
      const server = saveRemoteMcpServer({
        id: body.id ?? body.server_id,
        label: body.label,
        url: body.url,
        authType: body.auth_type ?? body.authType,
        enabled: body.enabled,
        notes: body.notes,
      })
      return NextResponse.json({ server })
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Could not save MCP server.' },
        { status: 400 }
      )
    }
  })
}
