import { NextResponse } from "next/server"

import { guardSensitiveRequest } from "@/lib/api/request-guard"
import {
  addWatchlistItem,
  listWatchlistAlerts,
  listWatchlistItems,
} from "@/lib/watchlist/store"
import type { WatchlistItemInput } from "@/lib/watchlist/schema"
import { getWatchlistWithQuotes } from "@/lib/watchlist/provider"

const NO_STORE = { "Cache-Control": "no-store" }

export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const includeQuotes = url.searchParams.get("quotes") !== "false"
    if (includeQuotes) {
      const result = await getWatchlistWithQuotes({
        force: url.searchParams.get("force") === "1",
      })
      return NextResponse.json(
        { ...result, alerts: listWatchlistAlerts() },
        { headers: NO_STORE }
      )
    }
    return NextResponse.json(
      {
        items: listWatchlistItems(),
        alerts: listWatchlistAlerts(),
      },
      { headers: NO_STORE }
    )
  } catch (error) {
    console.error("Failed to list watchlist", error)
    return NextResponse.json(
      { error: "Failed to list watchlist" },
      { status: 500, headers: NO_STORE }
    )
  }
}

export async function POST(request: Request) {
  const guard = guardSensitiveRequest(request)
  if (guard) return guard

  try {
    const body = (await request.json()) as Partial<WatchlistItemInput>
    const result = addWatchlistItem({
      kind: body.kind === "product" ? "product" : "financial",
      symbol: typeof body.symbol === "string" ? body.symbol : "",
      url: typeof body.url === "string" ? body.url : undefined,
      source: typeof body.source === "string" ? body.source : undefined,
      providerSymbol:
        typeof body.providerSymbol === "string"
          ? body.providerSymbol
          : undefined,
      tradingViewSymbol:
        typeof body.tradingViewSymbol === "string"
          ? body.tradingViewSymbol
          : undefined,
      name: typeof body.name === "string" ? body.name : undefined,
      exchange: typeof body.exchange === "string" ? body.exchange : undefined,
      currency: typeof body.currency === "string" ? body.currency : undefined,
      assetClass: body.assetClass,
      notes: typeof body.notes === "string" ? body.notes : undefined,
      movePercent:
        typeof body.movePercent === "number" ? body.movePercent : undefined,
      monitorEnabled:
        typeof body.monitorEnabled === "boolean"
          ? body.monitorEnabled
          : undefined,
      price: typeof body.price === "number" ? body.price : undefined,
      observedAt:
        typeof body.observedAt === "number" ? body.observedAt : undefined,
    })
    void import("@/lib/monitoring/watchlist-adapter")
      .then(({ syncMarketsMonitorActivation }) =>
        syncMarketsMonitorActivation()
      )
      .catch(() => {})
    return NextResponse.json(result, { headers: NO_STORE })
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to add watchlist item"
    return NextResponse.json(
      { error: message },
      { status: 400, headers: NO_STORE }
    )
  }
}
