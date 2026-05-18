import type {
    WatchlistCandle,
    WatchlistDataStatus,
    WatchlistItemWithQuote,
    WatchlistRange,
    WatchlistSearchResult,
} from './schema'
import {
    listWatchlistItems,
    normalizeProviderSymbol,
    readHistoryCache,
    readQuoteCache,
    writeHistoryCache,
    writeQuoteCache,
} from './store'
import {
    fetchTwelveDataHistory,
    fetchTwelveDataQuotes,
    getTwelveDataStatus,
    searchTwelveData,
} from './providers/twelve-data'

export const WATCHLIST_FINANCIAL_DATA_PROVIDER = 'twelve-data'
export const QUOTE_CACHE_MS = 10 * 60 * 1000
export const HISTORY_CACHE_MS = 15 * 60 * 1000

const HISTORY_RANGE: Record<WatchlistRange, { interval: string; outputsize: number }> = {
    '1D': { interval: '5min', outputsize: 100 },
    '5D': { interval: '30min', outputsize: 120 },
    '1M': { interval: '1day', outputsize: 32 },
    '6M': { interval: '1day', outputsize: 140 },
    '1Y': { interval: '1day', outputsize: 260 },
}

const POPULAR_RESULTS: WatchlistSearchResult[] = [
    { symbol: 'AAPL', providerSymbol: 'AAPL', tradingViewSymbol: 'NASDAQ:AAPL', name: 'Apple Inc.', exchange: 'NASDAQ', currency: 'USD', assetClass: 'stock' },
    { symbol: 'MSFT', providerSymbol: 'MSFT', tradingViewSymbol: 'NASDAQ:MSFT', name: 'Microsoft Corp.', exchange: 'NASDAQ', currency: 'USD', assetClass: 'stock' },
    { symbol: 'NVDA', providerSymbol: 'NVDA', tradingViewSymbol: 'NASDAQ:NVDA', name: 'NVIDIA Corp.', exchange: 'NASDAQ', currency: 'USD', assetClass: 'stock' },
    { symbol: 'TSLA', providerSymbol: 'TSLA', tradingViewSymbol: 'NASDAQ:TSLA', name: 'Tesla Inc.', exchange: 'NASDAQ', currency: 'USD', assetClass: 'stock' },
    { symbol: 'SPY', providerSymbol: 'SPY', tradingViewSymbol: 'AMEX:SPY', name: 'SPDR S&P 500 ETF Trust', exchange: 'NYSE ARCA', currency: 'USD', assetClass: 'etf' },
    { symbol: 'QQQ', providerSymbol: 'QQQ', tradingViewSymbol: 'NASDAQ:QQQ', name: 'Invesco QQQ Trust', exchange: 'NASDAQ', currency: 'USD', assetClass: 'etf' },
    { symbol: 'BTC/USD', providerSymbol: 'BTC/USD', tradingViewSymbol: 'COINBASE:BTCUSD', name: 'Bitcoin / US Dollar', exchange: null, currency: 'USD', assetClass: 'crypto' },
    { symbol: 'ETH/USD', providerSymbol: 'ETH/USD', tradingViewSymbol: 'COINBASE:ETHUSD', name: 'Ethereum / US Dollar', exchange: null, currency: 'USD', assetClass: 'crypto' },
]

function isFresh(updatedAt: number | null | undefined, maxAgeMs: number): boolean {
    return typeof updatedAt === 'number' && Date.now() - updatedAt <= maxAgeMs
}

export function getWatchlistDataStatus(): WatchlistDataStatus {
    return getTwelveDataStatus()
}

export async function getWatchlistWithQuotes(options: { force?: boolean } = {}): Promise<{
    status: WatchlistDataStatus
    items: WatchlistItemWithQuote[]
    errors: string[]
}> {
    const status = getWatchlistDataStatus()
    const instruments = listWatchlistItems()
    const errors: string[] = []
    const cached = new Map<string, ReturnType<typeof readQuoteCache>>()
    const staleSymbols: string[] = []

    for (const instrument of instruments) {
        const cachedQuote = readQuoteCache(WATCHLIST_FINANCIAL_DATA_PROVIDER, instrument.providerSymbol)
        cached.set(instrument.providerSymbol, cachedQuote)
        if (options.force || !cachedQuote || !isFresh(cachedQuote.updatedAt, QUOTE_CACHE_MS)) {
            staleSymbols.push(instrument.providerSymbol)
        }
    }

    if (status.configured && staleSymbols.length > 0) {
        try {
            const fresh = await fetchTwelveDataQuotes(staleSymbols)
            for (const quote of fresh) {
                writeQuoteCache(WATCHLIST_FINANCIAL_DATA_PROVIDER, quote)
                cached.set(quote.providerSymbol, readQuoteCache(WATCHLIST_FINANCIAL_DATA_PROVIDER, quote.providerSymbol))
            }
        } catch (error) {
            errors.push(error instanceof Error ? error.message : 'Failed to refresh watchlist quotes.')
        }
    }

    const items = instruments.map(instrument => {
        const cachedQuote = cached.get(instrument.providerSymbol) ?? null
        return {
            ...instrument,
            quote: cachedQuote?.quote ?? null,
            quoteUpdatedAt: cachedQuote?.updatedAt ?? null,
            quoteStale: !cachedQuote || !isFresh(cachedQuote.updatedAt, QUOTE_CACHE_MS),
        }
    })

    return { status, items, errors }
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
    const range = HISTORY_RANGE[args.range] ?? HISTORY_RANGE['1M']
    const cached = readHistoryCache(WATCHLIST_FINANCIAL_DATA_PROVIDER, providerSymbol, args.range, range.interval)
    const stale = !cached || !isFresh(cached.updatedAt, HISTORY_CACHE_MS)

    if (status.configured && (args.force || stale)) {
        try {
            const candles = await fetchTwelveDataHistory({
                providerSymbol,
                interval: range.interval,
                outputsize: range.outputsize,
            })
            writeHistoryCache(WATCHLIST_FINANCIAL_DATA_PROVIDER, providerSymbol, args.range, range.interval, candles)
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
                error: error instanceof Error ? error.message : 'Failed to refresh watchlist history.',
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
    const fallback = POPULAR_RESULTS
        .filter(item =>
            item.symbol.includes(normalized) ||
            item.name.toUpperCase().includes(normalized) ||
            item.providerSymbol.includes(normalized)
        )
        .slice(0, 8)

    if (!normalized) return { status, results: POPULAR_RESULTS.slice(0, 8) }
    if (!status.configured) return { status, results: fallback, error: status.message }

    try {
        const results = await searchTwelveData(query)
        return { status, results: results.length ? results : fallback }
    } catch (error) {
        return {
            status,
            results: fallback,
            error: error instanceof Error ? error.message : 'Failed to search watchlist instruments.',
        }
    }
}
