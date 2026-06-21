import { NextResponse } from 'next/server'

import { guardSensitiveRequest } from '@/lib/api/request-guard'
import { removeRemoteMcpServer } from '@/lib/integrations/mcp'
import { runWithRequestProfile } from '@/lib/profiles/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  return runWithRequestProfile(request, async () => {
    const guard = guardSensitiveRequest(request)
    if (guard) return guard

    try {
      const body = await request.json().catch(() => ({}))
      const serverId = typeof body.server_id === 'string'
        ? body.server_id
        : typeof body.serverId === 'string'
          ? body.serverId
          : ''
      if (!serverId) throw new Error('server_id is required.')
      const removed = removeRemoteMcpServer(serverId)
      return NextResponse.json({ removed })
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Could not remove MCP server.' },
        { status: 400 }
      )
    }
  })
}
