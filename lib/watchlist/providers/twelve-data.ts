import type { WatchlistAssetClass, WatchlistCandle, WatchlistQuote, WatchlistSearchResult } from '../schema'
import { getEnvValue } from '@/lib/config'
import { buildTradingViewSymbol, normalizeProviderSymbol } from '../store'

const BASE_URL = 'https://api.twelvedata.com'
const PROVIDER = 'twelve-data'
const TIMEOUT_MS = 12_000

type JsonObject = Record<string, unknown>

function apiKey(): string {
    return getEnvValue('TWELVE_DATA_API_KEY')?.trim() || getEnvValue('MARKET_DATA_API_KEY')?.trim() || ''
}

export function getTwelveDataStatus() {
    const configured = apiKey().length > 0
    return {
        provider: PROVIDER,
        configured,
        message: configured
            ? undefined
            : 'Set TWELVE_DATA_API_KEY to enable full financial search, quotes, and history. Without it, Watchlist only shows a few built-in examples.',
    }
}

function num(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value.replace(/,/g, ''))
        if (Number.isFinite(parsed)) return parsed
    }
    return null
}

function str(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null
}

function inferAssetClass(type: string | null, symbol: string): WatchlistAssetClass {
    const t = type?.toLowerCase() ?? ''
    if (t.includes('crypto') || t.includes('digital')) return 'crypto'
    if (t.includes('forex') || t.includes('currency')) return 'forex'
    if (t.includes('etf')) return 'etf'
    if (t.includes('index')) return 'index'
    if (t.includes('fund')) return 'fund'
    if (/^[A-Z0-9]+\/[A-Z0-9]+$/.test(symbol)) {
        const quote = symbol.split('/')[1]
        return ['USD', 'USDT', 'USDC', 'BTC', 'ETH'].includes(quote) ? 'crypto' : 'forex'
    }
    return 'stock'
}

function ensureConfigured(): string {
    const key = apiKey()
    if (!key) throw new Error('TWELVE_DATA_API_KEY is not configured.')
    return key
}

async function fetchJson(path: string, params: Record<string, string>): Promise<JsonObject> {
    const key = ensureConfigured()
    const url = new URL(path, BASE_URL)
    for (const [k, v] of Object.entries(params)) {
        if (v) url.searchParams.set(k, v)
    }
    url.searchParams.set('apikey', key)

    const response = await fetch(url, {
        cache: 'no-store',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { Accept: 'application/json' },
    })
    if (!response.ok) {
        throw new Error(`Twelve Data request failed (${response.status}).`)
    }
    const data = await response.json() as JsonObject
    if (data.status === 'error') {
        const message = typeof data.message === 'string' ? data.message : 'Twelve Data returned an error.'
        throw new Error(message)
    }
    return data
}

function quoteFromPayload(payload: JsonObject, fallbackSymbol: string): WatchlistQuote | null {
    const providerSymbol = normalizeProviderSymbol(str(payload.symbol) ?? fallbackSymbol)
    if (!providerSymbol) return null

    const price = num(payload.close) ?? num(payload.price) ?? num(payload.c)
    const open = num(payload.open)
    const previousClose = num(payload.previous_close) ?? num(payload.previousClose)
    const change = num(payload.change)
    const changePercent = num(payload.percent_change) ?? num(payload.change_percent)
    const timestampSeconds = num(payload.timestamp)
    const datetime = str(payload.datetime)
    const timestamp = timestampSeconds
        ? timestampSeconds * 1000
        : datetime
            ? Date.parse(datetime)
            : null

    return {
        provider: PROVIDER,
        providerSymbol,
        symbol: providerSymbol,
        name: str(payload.name),
        exchange: str(payload.exchange),
        currency: str(payload.currency),
        price,
        open,
        high: num(payload.high),
        low: num(payload.low),
        previousClose,
        change,
        changePercent,
        volume: num(payload.volume),
        timestamp: Number.isFinite(timestamp) ? timestamp : null,
    }
}

export async function fetchTwelveDataQuotes(providerSymbols: string[]): Promise<WatchlistQuote[]> {
    const symbols = Array.from(new Set(providerSymbols.map(normalizeProviderSymbol).filter(Boolean)))
    if (symbols.length === 0) return []

    const data = await fetchJson('/quote', { symbol: symbols.join(',') })
    const out: WatchlistQuote[] = []

    if (str(data.symbol)) {
        const quote = quoteFromPayload(data, symbols[0])
        if (quote) out.push(quote)
        return out
    }

    for (const symbol of symbols) {
        const item = data[symbol]
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue
        const quote = quoteFromPayload(item as JsonObject, symbol)
        if (quote) out.push(quote)
    }

    return out
}

function candleFromPayload(payload: JsonObject): WatchlistCandle | null {
    const datetime = str(payload.datetime)
    const timestamp = datetime ? Date.parse(datetime) : NaN
    const open = num(payload.open)
    const high = num(payload.high)
    const low = num(payload.low)
    const close = num(payload.close)
    if (!datetime || !Number.isFinite(timestamp) || open == null || high == null || low == null || close == null) {
        return null
    }
    return {
        time: datetime,
        timestamp,
        open,
        high,
        low,
        close,
        volume: num(payload.volume),
    }
}

export async function fetchTwelveDataHistory(args: {
    providerSymbol: string
    interval: string
    outputsize: number
}): Promise<WatchlistCandle[]> {
    const symbol = normalizeProviderSymbol(args.providerSymbol)
    if (!symbol) return []
    const data = await fetchJson('/time_series', {
        symbol,
        interval: args.interval,
        outputsize: String(args.outputsize),
        order: 'ASC',
    })
    const values = Array.isArray(data.values) ? data.values : []
    return values
        .map(item => item && typeof item === 'object' && !Array.isArray(item) ? candleFromPayload(item as JsonObject) : null)
        .filter((item): item is WatchlistCandle => item !== null)
        .sort((a, b) => a.timestamp - b.timestamp)
}

export async function searchTwelveData(query: string): Promise<WatchlistSearchResult[]> {
    const q = query.trim()
    if (!q) return []
    const data = await fetchJson('/symbol_search', { symbol: q })
    const rows = Array.isArray(data.data) ? data.data : []

    return rows
        .map(item => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return null
            const row = item as JsonObject
            const providerSymbol = normalizeProviderSymbol(str(row.symbol) ?? '')
            if (!providerSymbol) return null
            const exchange = str(row.exchange)
            const assetClass = inferAssetClass(str(row.instrument_type), providerSymbol)
            return {
                symbol: providerSymbol,
                providerSymbol,
                tradingViewSymbol: buildTradingViewSymbol({
                    symbol: providerSymbol,
                    providerSymbol,
                    exchange,
                    assetClass,
                }),
                name: str(row.instrument_name) ?? str(row.name) ?? providerSymbol,
                exchange,
                currency: str(row.currency),
                assetClass,
            } satisfies WatchlistSearchResult
        })
        .filter((item): item is WatchlistSearchResult => item !== null)
        .slice(0, 12)
}
