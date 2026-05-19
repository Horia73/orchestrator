import type {
  WatchlistCandle,
  WatchlistDataStatus,
  WatchlistItem,
  WatchlistItemWithQuote,
  WatchlistObservation,
  WatchlistQuote,
  WatchlistRange,
  WatchlistSearchResult,
} from "./schema"
import {
  getWatchlistItem,
  latestWatchlistObservations,
  listWatchlistObservations,
  listWatchlistItems,
  normalizeProviderSymbol,
  readHistoryCache,
  readQuoteCache,
  writeHistoryCache,
  writeQuoteCache,
} from "./store"
import {
  fetchTwelveDataHistory,
  fetchTwelveDataQuotes,
  getTwelveDataStatus,
  searchTwelveData,
} from "./providers/twelve-data"

export const WATCHLIST_FINANCIAL_DATA_PROVIDER = "twelve-data"
export const WATCHLIST_PRODUCT_DATA_PROVIDER = "local-product"
export const QUOTE_CACHE_MS = 10 * 60 * 1000
export const HISTORY_CACHE_MS = 15 * 60 * 1000

const HISTORY_RANGE: Record<
  WatchlistRange,
  { interval: string; outputsize: number }
> = {
  "1D": { interval: "5min", outputsize: 100 },
  "5D": { interval: "30min", outputsize: 120 },
  "1M": { interval: "1day", outputsize: 32 },
  "6M": { interval: "1day", outputsize: 140 },
  "1Y": { interval: "1day", outputsize: 260 },
}

const POPULAR_RESULTS: WatchlistSearchResult[] = [
  {
    symbol: "AAPL",
    providerSymbol: "AAPL",
    tradingViewSymbol: "NASDAQ:AAPL",
    name: "Apple Inc.",
    exchange: "NASDAQ",
    currency: "USD",
    assetClass: "stock",
  },
  {
    symbol: "MSFT",
    providerSymbol: "MSFT",
    tradingViewSymbol: "NASDAQ:MSFT",
    name: "Microsoft Corp.",
    exchange: "NASDAQ",
    currency: "USD",
    assetClass: "stock",
  },
  {
    symbol: "NVDA",
    providerSymbol: "NVDA",
    tradingViewSymbol: "NASDAQ:NVDA",
    name: "NVIDIA Corp.",
    exchange: "NASDAQ",
    currency: "USD",
    assetClass: "stock",
  },
  {
    symbol: "TSLA",
    providerSymbol: "TSLA",
    tradingViewSymbol: "NASDAQ:TSLA",
    name: "Tesla Inc.",
    exchange: "NASDAQ",
    currency: "USD",
    assetClass: "stock",
  },
  {
    symbol: "SPY",
    providerSymbol: "SPY",
    tradingViewSymbol: "AMEX:SPY",
    name: "SPDR S&P 500 ETF Trust",
    exchange: "NYSE ARCA",
    currency: "USD",
    assetClass: "etf",
  },
  {
    symbol: "QQQ",
    providerSymbol: "QQQ",
    tradingViewSymbol: "NASDAQ:QQQ",
    name: "Invesco QQQ Trust",
    exchange: "NASDAQ",
    currency: "USD",
    assetClass: "etf",
  },
  {
    symbol: "BTC/USD",
    providerSymbol: "BTC/USD",
    tradingViewSymbol: "COINBASE:BTCUSD",
    name: "Bitcoin / US Dollar",
    exchange: null,
    currency: "USD",
    assetClass: "crypto",
  },
  {
    symbol: "ETH/USD",
    providerSymbol: "ETH/USD",
    tradingViewSymbol: "COINBASE:ETHUSD",
    name: "Ethereum / US Dollar",
    exchange: null,
    currency: "USD",
    assetClass: "crypto",
  },
]

function isFresh(
  updatedAt: number | null | undefined,
  maxAgeMs: number
): boolean {
  return typeof updatedAt === "number" && Date.now() - updatedAt <= maxAgeMs
}

function rangeStart(range: WatchlistRange): number {
  const day = 24 * 60 * 60 * 1000
  switch (range) {
    case "1D":
      return Date.now() - day
    case "5D":
      return Date.now() - 5 * day
    case "6M":
      return Date.now() - 183 * day
    case "1Y":
      return Date.now() - 365 * day
    case "1M":
    default:
      return Date.now() - 31 * day
  }
}

function productQuote(item: WatchlistItem): {
  quote: WatchlistQuote | null
  quoteUpdatedAt: number | null
  quoteStale: boolean
} {
  const observations = latestWatchlistObservations(item.id, 2)
  const latest = observations[0]
  if (!latest || latest.price == null) {
    return { quote: null, quoteUpdatedAt: null, quoteStale: true }
  }
  const previous = observations.find(
    (obs) => obs.id !== latest.id && obs.price != null
  )
  const previousPrice = previous?.price ?? null
  const change = previousPrice == null ? null : latest.price - previousPrice
  const changePercent =
    previousPrice == null || previousPrice === 0 || change == null
      ? null
      : (change / previousPrice) * 100
  return {
    quote: {
      provider: WATCHLIST_PRODUCT_DATA_PROVIDER,
      providerSymbol: item.providerSymbol,
      symbol: item.symbol,
      name: item.name,
      exchange: item.exchange,
      currency: item.currency,
      price: latest.price,
      open: previousPrice,
      high: null,
      low: null,
      previousClose: previousPrice,
      change,
      changePercent,
      volume: null,
      timestamp: latest.ts,
    },
    quoteUpdatedAt: latest.ts,
    quoteStale: false,
  }
}

function observationsToCandles(
  observations: WatchlistObservation[]
): WatchlistCandle[] {
  return observations
    .filter((obs) => obs.price != null)
    .map((obs) => ({
      time: new Date(obs.ts).toISOString(),
      timestamp: obs.ts,
      open: obs.price ?? 0,
      high: obs.price ?? 0,
      low: obs.price ?? 0,
      close: obs.price ?? 0,
      volume: null,
    }))
}

export function getWatchlistDataStatus(): WatchlistDataStatus {
  return getTwelveDataStatus()
}

export async function getWatchlistWithQuotes(
  options: { force?: boolean } = {}
): Promise<{
  status: WatchlistDataStatus
  items: WatchlistItemWithQuote[]
  errors: string[]
}> {
  const status = getWatchlistDataStatus()
  const instruments = listWatchlistItems()
  const financialItems = instruments.filter((item) => item.kind === "financial")
  const errors: string[] = []
  const cached = new Map<string, ReturnType<typeof readQuoteCache>>()
  const staleSymbols: string[] = []

  for (const instrument of financialItems) {
    const cachedQuote = readQuoteCache(
      WATCHLIST_FINANCIAL_DATA_PROVIDER,
      instrument.providerSymbol
    )
    cached.set(instrument.providerSymbol, cachedQuote)
    if (
      options.force ||
      !cachedQuote ||
      !isFresh(cachedQuote.updatedAt, QUOTE_CACHE_MS)
    ) {
      staleSymbols.push(instrument.providerSymbol)
    }
  }

  if (status.configured && staleSymbols.length > 0) {
    try {
      const fresh = await fetchTwelveDataQuotes(staleSymbols)
      for (const quote of fresh) {
        writeQuoteCache(WATCHLIST_FINANCIAL_DATA_PROVIDER, quote)
        cached.set(
          quote.providerSymbol,
          readQuoteCache(
            WATCHLIST_FINANCIAL_DATA_PROVIDER,
            quote.providerSymbol
          )
        )
      }
    } catch (error) {
      errors.push(
        error instanceof Error
          ? error.message
          : "Failed to refresh watchlist quotes."
      )
    }
  }

  const items = instruments.map((instrument) => {
    if (instrument.kind === "product") {
      return {
        ...instrument,
        ...productQuote(instrument),
      }
    }
    const cachedQuote = cached.get(instrument.providerSymbol) ?? null
    return {
      ...instrument,
      quote: cachedQuote?.quote ?? null,
      quoteUpdatedAt: cachedQuote?.updatedAt ?? null,
      quoteStale:
        !cachedQuote || !isFresh(cachedQuote.updatedAt, QUOTE_CACHE_MS),
    }
  })

  return { status, items, errors }
}

export async function getWatchlistItemHistory(args: {
  itemId: string
  range: WatchlistRange
  force?: boolean
}): Promise<{
  status: WatchlistDataStatus
  candles: WatchlistCandle[]
  updatedAt: number | null
  stale: boolean
  interval: string
  error?: string
}> {
  const item = getWatchlistItem(args.itemId)
  if (!item) {
    return {
      status: { provider: "watchlist", configured: true },
      candles: [],
      updatedAt: null,
      stale: true,
      interval: "",
      error: "Watchlist item not found.",
    }
  }
  if (item.kind === "financial") {
    return getWatchlistFinancialHistory({
      providerSymbol: item.providerSymbol,
      range: args.range,
      force: args.force,
    })
  }

  const observations = listWatchlistObservations(item.id, {
    since: rangeStart(args.range),
    limit: 500,
  })
  const candles = observationsToCandles(observations)
  return {
    status: { provider: WATCHLIST_PRODUCT_DATA_PROVIDER, configured: true },
    candles,
    updatedAt: observations.at(-1)?.ts ?? null,
    stale: candles.length === 0,
    interval: "observed",
  }
}

export async function getWatchlistFinancialHistory(args: {
  providerSymbol: string
  range: WatchlistRange
  force?: boolean
}): Promise<{
  status: WatchlistDataStatus
  candles: WatchlistCandle[]
  updatedAt: number | null
  stale: boolean
  interval: string
  error?: string
}> {
  const status = getWatchlistDataStatus()
  const providerSymbol = normalizeProviderSymbol(args.providerSymbol)
  const range = HISTORY_RANGE[args.range] ?? HISTORY_RANGE["1M"]
  const cached = readHistoryCache(
    WATCHLIST_FINANCIAL_DATA_PROVIDER,
    providerSymbol,
    args.range,
    range.interval
  )
  const stale = !cached || !isFresh(cached.updatedAt, HISTORY_CACHE_MS)

  if (status.configured && (args.force || stale)) {
    try {
      const candles = await fetchTwelveDataHistory({
        providerSymbol,
        interval: range.interval,
        outputsize: range.outputsize,
      })
      writeHistoryCache(
        WATCHLIST_FINANCIAL_DATA_PROVIDER,
        providerSymbol,
        args.range,
        range.interval,
        candles
      )
      return {
        status,
        candles,
        updatedAt: Date.now(),
        stale: false,
        interval: range.interval,
      }
    } catch (error) {
      return {
        status,
        candles: cached?.candles ?? [],
        updatedAt: cached?.updatedAt ?? null,
        stale: true,
        interval: range.interval,
        error:
          error instanceof Error
            ? error.message
            : "Failed to refresh watchlist history.",
      }
    }
  }

  return {
    status,
    candles: cached?.candles ?? [],
    updatedAt: cached?.updatedAt ?? null,
    stale,
    interval: range.interval,
    error: status.configured ? undefined : status.message,
  }
}

export async function searchWatchlistItems(query: string): Promise<{
  status: WatchlistDataStatus
  results: WatchlistSearchResult[]
  error?: string
}> {
  const status = getWatchlistDataStatus()
  const normalized = query.trim().toUpperCase()
  const fallback = POPULAR_RESULTS.filter(
    (item) =>
      item.symbol.includes(normalized) ||
      item.name.toUpperCase().includes(normalized) ||
      item.providerSymbol.includes(normalized)
  ).slice(0, 8)

  if (!normalized) return { status, results: POPULAR_RESULTS.slice(0, 8) }
  if (!status.configured)
    return { status, results: fallback, error: status.message }

  try {
    const results = await searchTwelveData(query)
    return { status, results: results.length ? results : fallback }
  } catch (error) {
    return {
      status,
      results: fallback,
      error:
        error instanceof Error
          ? error.message
          : "Failed to search watchlist instruments.",
    }
  }
}
