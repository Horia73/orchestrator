import { NextResponse } from 'next/server'

import { resolveAppForArtifact } from '@/lib/apps/store'
import { runWithRequestProfile } from "@/lib/profiles/server"

/**
 * GET /api/apps/resolve?artifactId=…
 *
 * The sandbox renderers ask which registered app (if any) a rendered artifact
 * belongs to, so they know whether to wire the AppHost data bridge. Matches
 * the app's current artifact or any version in the same identifier chain.
 */
export async function GET(request: Request) {
  return runWithRequestProfile(request, async () => {
        const artifactId = new URL(request.url).searchParams.get('artifactId')?.trim()
        if (!artifactId) {
            return NextResponse.json({ error: 'artifactId is required' }, { status: 400 })
        }
        const app = resolveAppForArtifact(artifactId)
        return NextResponse.json({
            app: app ? { id: app.id, slug: app.slug, title: app.title } : null,
        })
  })
}
