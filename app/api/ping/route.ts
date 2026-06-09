// Minimal device→server reachability probe. No DB, no profile, no work — it
// exists purely so the client can tell whether it can still reach the Node
// server right now (used by the chat "Reconnecting…" indicator). Always
// dynamic and uncacheable so a 204 means the request actually round-tripped to
// the server, not a cache/service-worker hit.
export const dynamic = "force-dynamic"

const NO_STORE = {
  "cache-control": "no-store, no-cache, must-revalidate",
} as const

export function GET() {
  return new Response(null, { status: 204, headers: NO_STORE })
}

export function HEAD() {
  return new Response(null, { status: 204, headers: NO_STORE })
}
