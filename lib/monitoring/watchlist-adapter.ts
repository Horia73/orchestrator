import { randomUUID } from "crypto"

import db from "@/lib/db"
import {
  getWatchlistDataStatus,
  getWatchlistWithQuotes,
} from "@/lib/watchlist/provider"
import {
  hasActiveWatchlistMonitoring,
  listWatchlistAlerts,
} from "@/lib/watchlist/store"

import {
  registerMarketsAdapter,
  type MarketsAdapter,
  type MonitoredInstrument,
} from "./markets-heartbeat"

// The single seam between the consolidated monitor engine and the (separately
// owned) watchlist data layer. Additive only: reads via the watchlist's public
// API + 3 direct ops on its own stable tables. Zero edits to that layer, so
// either side can evolve independently.

type Quoteish = {
  price?: number | null
  previousClose?: number | null
  changePercent?: number | null
} | null
type ItemWithQuote = {
  id: string
  kind: string
  symbol: string
  name: string
  assetClass: MonitoredInstrument["assetClass"]
  quote: Quoteish
}

const insertObservation = db.prepare(`
    INSERT INTO watchlist_observations (id, itemId, providerSymbol, price, changePercent, ts)
    VALUES (@id, @itemId, @providerSymbol, @price, @changePercent, @ts)
`)
const updateAlertTriggered = db.prepare(`
    UPDATE watchlist_alerts SET lastTriggeredAt = @at, updatedAt = @at WHERE id = @id
`)

const adapter: MarketsAdapter = {
  async snapshot() {
    const { status, items } = await getWatchlistWithQuotes({ force: true })
    // Per-item monitoring config lives on watchlist_items (movePercent /
    // monitorEnabled columns). Read directly so we don't depend on the
    // item mapper exposing them.
    const cfgRows = db
      .prepare("SELECT id, movePercent, monitorEnabled FROM watchlist_items")
      .all() as Array<{
      id: string
      movePercent: number | null
      monitorEnabled: number | null
    }>
    const cfg = new Map(cfgRows.map((r) => [r.id, r]))

    const instruments: MonitoredInstrument[] = (items as ItemWithQuote[])
      .filter((it) => it.kind === "financial")
      .map((it) => {
        const c = cfg.get(it.id)
        return {
          id: it.id,
          symbol: it.symbol,
          name: it.name,
          assetClass: it.assetClass,
          movePercent: c?.movePercent ?? null,
          monitorEnabled: c ? c.monitorEnabled !== 0 : false,
          price: it.quote?.price ?? null,
          previousClose: it.quote?.previousClose ?? null,
          changePercent: it.quote?.changePercent ?? null,
        }
      })

    const alerts = listWatchlistAlerts().map((a) => ({
      id: a.id,
      instrumentId: a.itemId,
      condition: a.condition,
      value: a.value,
      enabled: a.enabled,
      lastTriggeredAt: a.lastTriggeredAt,
    }))

    return {
      configured: status.configured,
      message: status.message,
      instruments,
      alerts,
    }
  },

  appendObservation(o) {
    try {
      insertObservation.run({
        id: `obs_${randomUUID()}`,
        itemId: o.instrumentId,
        providerSymbol: o.providerSymbol,
        price: o.price,
        changePercent: o.changePercent,
        ts: o.ts,
      })
    } catch {
      /* observation history is best-effort */
    }
  },

  markAlertTriggered(alertId, at) {
    try {
      updateAlertTriggered.run({ id: alertId, at })
    } catch {
      /* best-effort */
    }
  },
}

let wired = false
function shouldEnableMarketsMonitor(): boolean {
  return getWatchlistDataStatus().configured && hasActiveWatchlistMonitoring()
}

export async function syncMarketsMonitorActivation(): Promise<void> {
  const { ensureMarketsHeartbeat } = await import("./markets-heartbeat")
  await ensureMarketsHeartbeat({ enabled: shouldEnableMarketsMonitor() })
}

/** Idempotent: register the adapter and arm the system heartbeat. Call at boot. */
export async function wireMarketsMonitor(): Promise<void> {
  if (!wired) {
    wired = true
    registerMarketsAdapter(adapter)
  }
  await syncMarketsMonitorActivation()
}
