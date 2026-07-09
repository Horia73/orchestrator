import type { BillingUsageEntry } from "./schema"

// Provider usage payloads are also streamed to the browser. Keep Orchestrator's
// richer billing metadata on a Symbol so it survives the in-process handoff to
// the observability logger without leaking into the public SSE JSON payload.
const BILLING_METADATA = Symbol.for(
  "orchestrator.observability.billing-metadata"
)

type UsageWithBillingMetadata = Record<PropertyKey, unknown> & {
  [BILLING_METADATA]?: BillingUsageEntry[]
}

export function attachBillingMetadata(
  rawUsage: unknown,
  entries: BillingUsageEntry[]
): unknown {
  if (entries.length === 0) return rawUsage
  const usage =
    rawUsage && typeof rawUsage === "object" && !Array.isArray(rawUsage)
      ? { ...(rawUsage as Record<string, unknown>) }
      : {}
  Object.defineProperty(usage, BILLING_METADATA, {
    value: entries,
    enumerable: false,
    configurable: false,
    writable: false,
  })
  return usage
}

export function readBillingMetadata(
  rawUsage: unknown
): BillingUsageEntry[] | null {
  if (!rawUsage || typeof rawUsage !== "object" || Array.isArray(rawUsage))
    return null
  const entries = (rawUsage as UsageWithBillingMetadata)[BILLING_METADATA]
  return Array.isArray(entries) && entries.length > 0 ? entries : null
}
