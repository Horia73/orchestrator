export type WatchlistAssetClass =
  | "stock"
  | "etf"
  | "crypto"
  | "forex"
  | "index"
  | "fund"
  | "other"

export type WatchlistItemKind = "financial" | "product"

export type WatchlistRange = "1D" | "5D" | "1M" | "6M" | "1Y"

export interface WatchlistItem {
  id: string
  kind: WatchlistItemKind
  symbol: string
  providerSymbol: string
  tradingViewSymbol: string | null
  url: string | null
  name: string
  exchange: string | null
  currency: string | null
  assetClass: WatchlistAssetClass
  imageUrl: string | null
  movePercent: number | null
  monitorEnabled: boolean
  sortOrder: number
  notes: string | null
  createdAt: number
  updatedAt: number
}

export interface WatchlistQuote {
  provider: string
  providerSymbol: string
  symbol: string
  name: string | null
  exchange: string | null
  currency: string | null
  price: number | null
  open: number | null
  high: number | null
  low: number | null
  previousClose: number | null
  change: number | null
  changePercent: number | null
  volume: number | null
  timestamp: number | null
}

export interface WatchlistCandle {
  time: string
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number | null
}

export interface WatchlistObservation {
  id: string
  itemId: string
  providerSymbol: string
  price: number | null
  changePercent: number | null
  ts: number
}

export interface WatchlistSearchResult {
  symbol: string
  providerSymbol: string
  tradingViewSymbol: string | null
  name: string
  exchange: string | null
  currency: string | null
  assetClass: WatchlistAssetClass
}

export interface WatchlistItemInput {
  symbol: string
  kind?: WatchlistItemKind
  url?: string
  source?: string
  name?: string
  exchange?: string
  currency?: string
  assetClass?: WatchlistAssetClass
  imageUrl?: string | null
  providerSymbol?: string
  tradingViewSymbol?: string
  notes?: string
  movePercent?: number | null
  monitorEnabled?: boolean
  price?: number | null
  observedAt?: number
}

export interface WatchlistItemWithQuote extends WatchlistItem {
  quote: WatchlistQuote | null
  quoteUpdatedAt: number | null
  quoteStale: boolean
}

export interface WatchlistDataStatus {
  provider: string
  configured: boolean
  message?: string
}

export interface WatchlistAlert {
  id: string
  itemId: string
  condition: "above" | "below"
  value: number
  enabled: boolean
  lastTriggeredAt: number | null
  createdAt: number
  updatedAt: number
}
