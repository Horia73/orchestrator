import { NextResponse } from "next/server"

import {
  getWatchlistFinancialHistory,
  getWatchlistItemHistory,
} from "@/lib/watchlist/provider"
import type { WatchlistRange } from "@/lib/watchlist/schema"

const NO_STORE = { "Cache-Control": "no-store" }
const RANGES = new Set<WatchlistRange>(["1D", "5D", "1M", "6M", "1Y"])

export async function GET(request: Request) {
  try {
    const url = new URL(request.url)
    const symbol = url.searchParams.get("symbol") ?? ""
    const itemId = url.searchParams.get("itemId") ?? ""
    const rawRange = url.searchParams.get("range") ?? "1M"
    const range = RANGES.has(rawRange as WatchlistRange)
      ? (rawRange as WatchlistRange)
      : "1M"
    if (itemId.trim()) {
      const result = await getWatchlistItemHistory({
        itemId,
        range,
        force: url.searchParams.get("force") === "1",
      })
      return NextResponse.json(result, { headers: NO_STORE })
    }
    if (!symbol.trim()) {
      return NextResponse.json(
        { error: "symbol or itemId is required" },
        { status: 400, headers: NO_STORE }
      )
    }
    const result = await getWatchlistFinancialHistory({
      providerSymbol: symbol,
      range,
      force: url.searchParams.get("force") === "1",
    })
    return NextResponse.json(result, { headers: NO_STORE })
  } catch (error) {
    console.error("Failed to load watchlist history", error)
    return NextResponse.json(
      { error: "Failed to load watchlist history" },
      { status: 500, headers: NO_STORE }
    )
  }
}
