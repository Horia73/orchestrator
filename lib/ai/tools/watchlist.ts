import type { ToolDef, ToolResult } from "@/lib/ai/agents/types"
import type {
  WatchlistAssetClass,
  WatchlistItemInput,
} from "@/lib/watchlist/schema"
import {
  addWatchlistItem,
  appendProductPriceObservation,
  getWatchlistItem,
  listWatchlistItems,
  removeWatchlistItem,
} from "@/lib/watchlist/store"
import {
  getWatchlistWithQuotes,
  searchWatchlistItems,
} from "@/lib/watchlist/provider"

const ASSET_CLASSES = [
  "stock",
  "etf",
  "crypto",
  "forex",
  "index",
  "fund",
  "other",
] as const

function stringValue(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === "string") return value.trim()
  }
  return ""
}

function assetClassValue(value: unknown): WatchlistAssetClass | undefined {
  return typeof value === "string" &&
    (ASSET_CLASSES as readonly string[]).includes(value)
    ? (value as WatchlistAssetClass)
    : undefined
}

function numberValue(
  args: Record<string, unknown>,
  keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === "number" && Number.isFinite(value)) return value
    if (typeof value === "string") {
      const parsed = Number(value.replace(",", ".").replace(/[^\d.-]/g, ""))
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return undefined
}

export const watchlistAddFinancialInstrumentTool: ToolDef = {
  id: "WatchlistAddFinancialInstrument",
  name: "WatchlistAddFinancialInstrument",
  description: [
    "Add a financial instrument to the local Watchlist. Use this immediately when the user asks to track/watch/add a ticker, stock, ETF, forex pair, index, or crypto pair.",
    "It is idempotent: adding an already tracked symbol returns the existing row.",
    "For crypto/forex pairs prefer symbols like BTC/USD or EUR/USD. For listed equities prefer exchange when known, e.g. NASDAQ for AAPL/NVDA/MSFT.",
  ].join(" "),
  input_schema: {
    type: "object",
    properties: {
      symbol: {
        type: "string",
        description:
          "Ticker or pair the user wants tracked, e.g. AAPL, NVDA, BTC/USD.",
      },
      name: { type: "string", description: "Optional human display name." },
      exchange: {
        type: "string",
        description: "Optional exchange, e.g. NASDAQ, NYSE.",
      },
      currency: {
        type: "string",
        description: "Optional quote currency, e.g. USD.",
      },
      asset_class: {
        type: "string",
        enum: [...ASSET_CLASSES],
        description: "Optional asset class.",
      },
      provider_symbol: {
        type: "string",
        description: "Optional quote-provider symbol. Defaults to symbol.",
      },
      tradingview_symbol: {
        type: "string",
        description:
          "Optional TradingView symbol, e.g. NASDAQ:AAPL or COINBASE:BTCUSD.",
      },
    },
    required: ["symbol"],
  },
  tags: ["watchlist", "write"],
}

export const watchlistAddProductTool: ToolDef = {
  id: "WatchlistAddProduct",
  name: "WatchlistAddProduct",
  description: [
    "Add a product to the local Watchlist. Use this immediately when the user asks to track/watch/follow a product price or creates a product price monitor.",
    "It is idempotent by product URL when a URL is available. If the current price is known, pass it so the price chart starts with a baseline point.",
  ].join(" "),
  input_schema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Product page URL when known." },
      name: { type: "string", description: "Human product name." },
      source: {
        type: "string",
        description: "Store or website name, e.g. Roastmarket.",
      },
      currency: {
        type: "string",
        description: "ISO currency such as EUR, USD, RON.",
      },
      current_price: {
        type: "number",
        description: "Current observed product price.",
      },
      symbol: {
        type: "string",
        description: "Optional short display label if no URL is known.",
      },
      notes: { type: "string", description: "Optional tracking notes." },
    },
  },
  tags: ["watchlist", "write"],
}

export const watchlistRemoveItemTool: ToolDef = {
  id: "WatchlistRemoveItem",
  name: "WatchlistRemoveItem",
  description:
    "Remove a local Watchlist item by id, ticker, provider symbol, or display symbol.",
  input_schema: {
    type: "object",
    properties: {
      item: {
        type: "string",
        description:
          "Watchlist id, ticker, provider symbol, or display symbol to remove.",
      },
    },
    required: ["item"],
  },
  tags: ["watchlist", "write"],
}

export const watchlistListItemsTool: ToolDef = {
  id: "WatchlistListItems",
  name: "WatchlistListItems",
  description:
    "List local Watchlist items, including financial instruments and product price trackers. Optionally include cached/refreshed quote data.",
  input_schema: {
    type: "object",
    properties: {
      include_quotes: {
        type: "boolean",
        description:
          "When true, include quote data from cache/provider. Default false.",
      },
      refresh: {
        type: "boolean",
        description:
          "When include_quotes is true, force a provider refresh. Use sparingly because free APIs are rate-limited.",
      },
    },
  },
  tags: ["watchlist", "read"],
}

export const watchlistRecordProductPriceTool: ToolDef = {
  id: "WatchlistRecordProductPrice",
  name: "WatchlistRecordProductPrice",
  description: [
    "Append an observed price sample for a product Watchlist item. Use this on every product price monitor run after reading the current price, even when no notification is needed.",
    "If the product is not yet in Watchlist but url/name is provided, add it first and then record the price.",
  ].join(" "),
  input_schema: {
    type: "object",
    properties: {
      item: {
        type: "string",
        description: "Watchlist item id, product URL, or display label.",
      },
      url: {
        type: "string",
        description:
          "Product page URL, used to find or create the Watchlist item.",
      },
      name: {
        type: "string",
        description: "Human product name when creating a missing item.",
      },
      source: { type: "string", description: "Store or website name." },
      price: { type: "number", description: "Observed product price." },
      currency: {
        type: "string",
        description: "ISO currency such as EUR, USD, RON.",
      },
      observed_at: {
        type: "number",
        description: "Optional observation timestamp in epoch milliseconds.",
      },
    },
    required: ["price"],
  },
  tags: ["watchlist", "write"],
}

async function enrichInput(
  input: WatchlistItemInput
): Promise<WatchlistItemInput> {
  const symbol = input.providerSymbol || input.symbol
  if (!symbol) return input

  const existing = getWatchlistItem(symbol)
  if (existing) return input

  try {
    const search = await searchWatchlistItems(symbol)
    const normalized = symbol.trim().toUpperCase()
    const match =
      search.results.find(
        (item) => item.providerSymbol.toUpperCase() === normalized
      ) ??
      search.results.find((item) => item.symbol.toUpperCase() === normalized) ??
      search.results[0]
    if (!match) return input
    return {
      kind: "financial",
      symbol: input.symbol || match.symbol,
      providerSymbol: input.providerSymbol || match.providerSymbol,
      tradingViewSymbol:
        input.tradingViewSymbol || match.tradingViewSymbol || undefined,
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

export async function executeWatchlistAddFinancialInstrument(
  args: Record<string, unknown>
): Promise<ToolResult> {
  const symbol = stringValue(args, ["symbol", "ticker"])
  if (!symbol) return { success: false, error: "symbol is required." }

  const input = await enrichInput({
    kind: "financial",
    symbol,
    name: stringValue(args, ["name"]) || undefined,
    exchange: stringValue(args, ["exchange"]) || undefined,
    currency: stringValue(args, ["currency"]) || undefined,
    assetClass: assetClassValue(args.asset_class ?? args.assetClass),
    providerSymbol:
      stringValue(args, ["provider_symbol", "providerSymbol"]) || undefined,
    tradingViewSymbol:
      stringValue(args, ["tradingview_symbol", "tradingViewSymbol"]) ||
      undefined,
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
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to add watchlist item.",
    }
  }
}

export function executeWatchlistAddProduct(
  args: Record<string, unknown>
): ToolResult {
  const url = stringValue(args, ["url", "product_url", "productUrl"])
  const name = stringValue(args, ["name", "product_name", "productName"])
  const symbol = stringValue(args, ["symbol", "label"])
  if (!url && !name && !symbol)
    return { success: false, error: "url, name, or symbol is required." }

  try {
    const result = addWatchlistItem({
      kind: "product",
      symbol: symbol || name || url,
      url: url || undefined,
      source: stringValue(args, ["source", "store", "site"]) || undefined,
      name: name || undefined,
      currency: stringValue(args, ["currency"]) || undefined,
      notes: stringValue(args, ["notes"]) || undefined,
      price: numberValue(args, ["current_price", "currentPrice", "price"]),
    })
    return {
      success: true,
      data: {
        created: result.created,
        item: result.item,
        message: result.created
          ? `${result.item.name} added to Watchlist.`
          : `${result.item.name} is already in Watchlist.`,
      },
    }
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to add product to Watchlist.",
    }
  }
}

export function executeWatchlistRemoveItem(
  args: Record<string, unknown>
): ToolResult {
  const item = stringValue(args, ["item", "symbol_or_id", "symbol", "id"])
  if (!item) return { success: false, error: "item is required." }
  const deleted = removeWatchlistItem(item)
  return deleted
    ? { success: true, data: { deleted: true, item } }
    : { success: false, error: `No Watchlist item matched ${item}.` }
}

export async function executeWatchlistListItems(
  args: Record<string, unknown>
): Promise<ToolResult> {
  const includeQuotes =
    args.include_quotes === true || args.includeQuotes === true
  const refresh = args.refresh === true
  if (!includeQuotes) {
    return { success: true, data: { items: listWatchlistItems() } }
  }
  const data = await getWatchlistWithQuotes({ force: refresh })
  return { success: true, data }
}

export function executeWatchlistRecordProductPrice(
  args: Record<string, unknown>
): ToolResult {
  const price = numberValue(args, ["price", "current_price", "currentPrice"])
  if (price == null) return { success: false, error: "price is required." }

  const itemRef = stringValue(args, [
    "item",
    "item_id",
    "itemId",
    "url",
    "product_url",
    "productUrl",
  ])
  let item = itemRef ? getWatchlistItem(itemRef) : null
  if (!item) {
    const url = stringValue(args, ["url", "product_url", "productUrl"])
    const name = stringValue(args, ["name", "product_name", "productName"])
    const symbol = stringValue(args, ["symbol", "label"])
    if (!url && !name && !symbol) {
      return { success: false, error: "item or product identity is required." }
    }
    item = addWatchlistItem({
      kind: "product",
      symbol: symbol || name || url,
      url: url || undefined,
      source: stringValue(args, ["source", "store", "site"]) || undefined,
      name: name || undefined,
      currency: stringValue(args, ["currency"]) || undefined,
    }).item
  }

  try {
    const result = appendProductPriceObservation({
      itemIdOrSymbol: item.id,
      price,
      currency: stringValue(args, ["currency"]) || undefined,
      observedAt: numberValue(args, ["observed_at", "observedAt"]),
    })
    return { success: true, data: result }
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Failed to record product price.",
    }
  }
}

export const watchlistTools: ToolDef[] = [
  watchlistAddFinancialInstrumentTool,
  watchlistAddProductTool,
  watchlistRemoveItemTool,
  watchlistListItemsTool,
  watchlistRecordProductPriceTool,
]
