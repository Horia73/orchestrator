import { NextResponse } from 'next/server'
import { getRuntimeConfig } from '@/lib/config'
import { getEffectiveRegistry } from '@/lib/models/registry'
import { getAllAgents } from '@/lib/ai'
import { getProviderReadinessMap } from '@/lib/provider-readiness'
import { runWithProfileContext } from "@/lib/profiles/context"
import { getCurrentProfileFromCookies } from "@/lib/profiles/server"

/**
 * Single round-trip bootstrap for the settings page.
 * Returns runtime config + serializable view of agents + effective model registry
 * + per-provider API key status (so the UI can flag missing keys without round-trips).
 */
export async function GET() {
  const current = await getCurrentProfileFromCookies()
  if (!current) {
    return NextResponse.json(
      { error: "Profile required", code: "profile_required" },
      { status: 401, headers: { "Cache-Control": "no-store" } }
    )
  }
  if (!current.isAdmin && !current.profile.permissions.surfaces.settings) {
    return NextResponse.json(
      {
        error: "Profile is not allowed to access Settings.",
        code: "profile_settings_denied",
      },
      { status: 403, headers: { "Cache-Control": "no-store" } }
    )
  }

  return runWithProfileContext(
    { profileId: current.profile.id, role: current.profile.role },
    async () => {
        const config = getRuntimeConfig()
        const registry = getEffectiveRegistry()

        const agents = getAllAgents().map(a => ({
            id: a.id,
            name: a.name,
            description: a.description,
            kind: a.kind,
            status: a.status ?? 'active',
            tier: a.tier ?? 'primary',
            defaultProvider: a.provider,
            defaultModel: a.model,
            defaultThinkingLevel: a.thinkingLevel,
            canCallAgents: a.canCallAgents ?? [],
        }))

        // fast: serve last-known CLI/LM Studio state instead of blocking the
        // whole settings page behind process spawns; a background probe
        // refreshes the truth and the next bootstrap refresh picks it up.
        const providerStatus = await getProviderReadinessMap(registry, {
            fast: true,
        })

        return NextResponse.json({
            profileId: current.profile.id,
            isAdmin: current.isAdmin,
            permissions: current.profile.permissions,
            allowedTabs: current.isAdmin
                ? ["models", "integrations", "voice", "files", "remote", "logs", "usage", "notifications", "profiles", "updates"]
                : [
                    ...(current.profile.permissions.tools.models ? ["models"] : []),
                    "integrations",
                    "files",
                    "usage",
                    "notifications",
                ],
            canManageModelRegistry: current.isAdmin,
            canManageSettingsFiles:
                current.isAdmin || current.profile.permissions.tools.settings_files,
            config,
            agents,
            providers: registry,
            providerStatus,
        })
  })
}
