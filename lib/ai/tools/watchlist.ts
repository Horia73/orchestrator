import type { ToolDef, ToolResult } from '@/lib/ai/agents/types'
import type { WatchlistAssetClass, WatchlistItemInput } from '@/lib/watchlist/schema'
import {
    addWatchlistItem,
    getWatchlistItem,
    listWatchlistItems,
    removeWatchlistItem,
} from '@/lib/watchlist/store'
import { getWatchlistWithQuotes, searchWatchlistItems } from '@/lib/watchlist/provider'

const ASSET_CLASSES = ['stock', 'etf', 'crypto', 'forex', 'index', 'fund', 'other'] as const

function stringValue(args: Record<string, unknown>, keys: string[]): string {
    for (const key of keys) {
        const value = args[key]
        if (typeof value === 'string') return value.trim()
    }
    return ''
}

function assetClassValue(value: unknown): WatchlistAssetClass | undefined {
    return typeof value === 'string' && (ASSET_CLASSES as readonly string[]).includes(value)
        ? value as WatchlistAssetClass
        : undefined
}

export const watchlistAddFinancialInstrumentTool: ToolDef = {
    id: 'WatchlistAddFinancialInstrument',
    name: 'WatchlistAddFinancialInstrument',
    description: [
        'Add a financial instrument to the local Watchlist. Use this immediately when the user asks to track/watch/add a ticker, stock, ETF, forex pair, index, or crypto pair.',
        'It is idempotent: adding an already tracked symbol returns the existing row.',
        'For crypto/forex pairs prefer symbols like BTC/USD or EUR/USD. For listed equities prefer exchange when known, e.g. NASDAQ for AAPL/NVDA/MSFT.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            symbol: { type: 'string', description: 'Ticker or pair the user wants tracked, e.g. AAPL, NVDA, BTC/USD.' },
            name: { type: 'string', description: 'Optional human display name.' },
            exchange: { type: 'string', description: 'Optional exchange, e.g. NASDAQ, NYSE.' },
            currency: { type: 'string', description: 'Optional quote currency, e.g. USD.' },
            asset_class: { type: 'string', enum: [...ASSET_CLASSES], description: 'Optional asset class.' },
            provider_symbol: { type: 'string', description: 'Optional quote-provider symbol. Defaults to symbol.' },
            tradingview_symbol: { type: 'string', description: 'Optional TradingView symbol, e.g. NASDAQ:AAPL or COINBASE:BTCUSD.' },
        },
        required: ['symbol'],
    },
    tags: ['watchlist', 'write'],
}

export const watchlistRemoveItemTool: ToolDef = {
    id: 'WatchlistRemoveItem',
    name: 'WatchlistRemoveItem',
    description: 'Remove a local Watchlist item by id, ticker, provider symbol, or display symbol.',
    input_schema: {
        type: 'object',
        properties: {
            item: { type: 'string', description: 'Watchlist id, ticker, provider symbol, or display symbol to remove.' },
        },
        required: ['item'],
    },
    tags: ['watchlist', 'write'],
}

export const watchlistListItemsTool: ToolDef = {
    id: 'WatchlistListItems',
    name: 'WatchlistListItems',
    description: 'List local Watchlist items. Optionally include cached or refreshed quote data for financial instruments.',
    input_schema: {
        type: 'object',
        properties: {
            include_quotes: { type: 'boolean', description: 'When true, include quote data from cache/provider. Default false.' },
            refresh: { type: 'boolean', description: 'When include_quotes is true, force a provider refresh. Use sparingly because free APIs are rate-limited.' },
        },
    },
    tags: ['watchlist', 'read'],
}

async function enrichInput(input: WatchlistItemInput): Promise<WatchlistItemInput> {
    const symbol = input.providerSymbol || input.symbol
    if (!symbol) return input

    const existing = getWatchlistItem(symbol)
    if (existing) return input

    try {
        const search = await searchWatchlistItems(symbol)
        const normalized = symbol.trim().toUpperCase()
        const match =
            search.results.find(item => item.providerSymbol.toUpperCase() === normalized) ??
            search.results.find(item => item.symbol.toUpperCase() === normalized) ??
            search.results[0]
        if (!match) return input
        return {
            kind: 'financial',
            symbol: input.symbol || match.symbol,
            providerSymbol: input.providerSymbol || match.providerSymbol,
            tradingViewSymbol: input.tradingViewSymbol || match.tradingViewSymbol || undefined,
            name: input.name || match.name,
            exchange: input.exchange || match.exchange || undefined,
            currency: input.currency || match.currency || undefined,
            assetClass: input.assetClass || match.assetClass,
            notes: input.notes,
        }
    } catch {
        return input
    }
}

export async function executeWatchlistAddFinancialInstrument(args: Record<string, unknown>): Promise<ToolResult> {
    const symbol = stringValue(args, ['symbol', 'ticker'])
    if (!symbol) return { success: false, error: 'symbol is required.' }

    const input = await enrichInput({
        kind: 'financial',
        symbol,
        name: stringValue(args, ['name']) || undefined,
        exchange: stringValue(args, ['exchange']) || undefined,
        currency: stringValue(args, ['currency']) || undefined,
        assetClass: assetClassValue(args.asset_class ?? args.assetClass),
        providerSymbol: stringValue(args, ['provider_symbol', 'providerSymbol']) || undefined,
        tradingViewSymbol: stringValue(args, ['tradingview_symbol', 'tradingViewSymbol']) || undefined,
    })

    try {
        const result = addWatchlistItem(input)
        return {
            success: true,
            data: {
                created: result.created,
                item: result.item,
                message: result.created
                    ? `${result.item.symbol} added to Watchlist.`
                    : `${result.item.symbol} is already in Watchlist.`,
            },
        }
    } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Failed to add watchlist item.' }
    }
}

export function executeWatchlistRemoveItem(args: Record<string, unknown>): ToolResult {
    const item = stringValue(args, ['item', 'symbol_or_id', 'symbol', 'id'])
    if (!item) return { success: false, error: 'item is required.' }
    const deleted = removeWatchlistItem(item)
    return deleted
        ? { success: true, data: { deleted: true, item } }
        : { success: false, error: `No Watchlist item matched ${item}.` }
}

export async function executeWatchlistListItems(args: Record<string, unknown>): Promise<ToolResult> {
    const includeQuotes = args.include_quotes === true || args.includeQuotes === true
    const refresh = args.refresh === true
    if (!includeQuotes) {
        return { success: true, data: { items: listWatchlistItems() } }
    }
    const data = await getWatchlistWithQuotes({ force: refresh })
    return { success: true, data }
}

export const watchlistTools: ToolDef[] = [
    watchlistAddFinancialInstrumentTool,
    watchlistRemoveItemTool,
    watchlistListItemsTool,
]
