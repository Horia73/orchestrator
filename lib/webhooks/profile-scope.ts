import { runWithProfileContext } from "@/lib/profiles/context"
import {
  getProfileWebhookSlugOwner,
  listProfiles,
  registerProfileWebhookSlugOwner,
  unregisterProfileWebhookSlugOwner,
} from "@/lib/profiles/store"

import { getWebhookEndpointByIdOrSlug } from "./store"
import type { WebhookEndpoint } from "./schema"

export type WebhookProfileResolution =
  | { status: "found"; profileId: string; endpoint: WebhookEndpoint }
  | { status: "not_found" }
  | { status: "ambiguous"; profileIds: string[] }

export function resolveWebhookProfileBySlug(
  slug: string
): WebhookProfileResolution {
  const owner = getProfileWebhookSlugOwner(slug)
  if (owner) {
    const endpoint = runWithProfileContext(
      { profileId: owner.profileId },
      () => getWebhookEndpointByIdOrSlug(slug)
    )
    if (endpoint && endpoint.id === owner.endpointId) {
      return { status: "found", profileId: owner.profileId, endpoint }
    }
    unregisterProfileWebhookSlugOwner(slug, owner.endpointId)
  }

  const matches: Array<{ profileId: string; endpoint: WebhookEndpoint }> = []
  for (const profile of listProfiles()) {
    const endpoint = runWithProfileContext({ profileId: profile.id }, () =>
      getWebhookEndpointByIdOrSlug(slug)
    )
    if (endpoint) matches.push({ profileId: profile.id, endpoint })
  }

  if (matches.length === 0) return { status: "not_found" }
  if (matches.length > 1) {
    return {
      status: "ambiguous",
      profileIds: matches.map((match) => match.profileId),
    }
  }

  const match = matches[0]
  registerProfileWebhookSlugOwner({
    slug: match.endpoint.slug,
    profileId: match.profileId,
    endpointId: match.endpoint.id,
  })
  return { status: "found", ...match }
}
