import {
  addWatchlistItem,
  appendProductPriceObservation,
} from "@/lib/watchlist/store"
import type {
  WatchlistItem,
  WatchlistObservation,
} from "@/lib/watchlist/schema"

const URL_KEYS = ["product_url", "productUrl", "url"]
const CURRENCY_KEYS = ["currency", "currency_code", "currencyCode"]
const TIMESTAMP_KEYS = [
  "observed_at",
  "observedAt",
  "last_observed_at",
  "lastObservedAt",
  "checked_at",
  "checkedAt",
  "last_checked_at",
  "lastCheckedAt",
]
const PRODUCT_NAME_KEYS = [
  "product_name",
  "productName",
  "product_title",
  "productTitle",
  "name",
  "title",
]
const SOURCE_KEYS = ["source", "store", "site", "merchant"]
const PRICE_KEY_BASES = [
  "lastobservedprice",
  "lowestinstockprice",
  "currentprice",
  "observedprice",
  "price",
]

type ProductPriceState = {
  url: string
  price: number
  currency?: string
  observedAt?: number
  name?: string
  source?: string
}

export type ProductWatchlistTaskStateSyncResult = {
  item: WatchlistItem
  observation: WatchlistObservation
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function getString(
  state: Record<string, unknown>,
  keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = state[key]
    if (typeof value !== "string") continue
    const cleaned = value.trim()
    if (cleaned) return cleaned
  }
  return undefined
}

function normalizeKey(value: string): string {
  return value.replace(/[_\-\s]/g, "").toLowerCase()
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined
  }
  if (typeof value !== "string") return undefined

  const raw = value.trim()
  if (!raw) return undefined
  const numeric = raw.replace(/[^\d,.-]/g, "")
  if (!numeric || numeric === "-" || numeric === "." || numeric === ",") {
    return undefined
  }

  const lastComma = numeric.lastIndexOf(",")
  const lastDot = numeric.lastIndexOf(".")
  const normalized =
    lastComma > lastDot
      ? numeric.replace(/\./g, "").replace(",", ".")
      : numeric.replace(/,/g, "")
  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : undefined
}

function normalizeCurrency(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (trimmed === "€") return "EUR"
  if (trimmed === "$") return "USD"
  if (trimmed === "£") return "GBP"

  const letters = trimmed.replace(/[^a-z]/gi, "").toUpperCase()
  return /^[A-Z]{3}$/.test(letters) ? letters : undefined
}

function priceKeyCurrency(key: string): string | undefined {
  const normalized = normalizeKey(key)
  for (const base of PRICE_KEY_BASES) {
    if (normalized === base) return undefined
    if (!normalized.startsWith(base)) continue
    const suffix = normalized.slice(base.length)
    if (/^[a-z]{3}$/.test(suffix)) return suffix.toUpperCase()
  }
  return undefined
}

function isPriceKey(key: string): boolean {
  const normalized = normalizeKey(key)
  return PRICE_KEY_BASES.some((base) => {
    if (normalized === base) return true
    const suffix = normalized.slice(base.length)
    return normalized.startsWith(base) && /^[a-z]{3}$/.test(suffix)
  })
}

function getPrice(
  state: Record<string, unknown>
): { price: number; currency?: string } | null {
  for (const [key, value] of Object.entries(state)) {
    if (!isPriceKey(key)) continue
    const price = parseNumber(value)
    if (price === undefined) continue
    return { price, currency: priceKeyCurrency(key) }
  }
  return null
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 && value < 10_000_000_000 ? value * 1000 : value
  }
  if (typeof value !== "string") return undefined

  const trimmed = value.trim()
  if (!trimmed) return undefined
  const numeric = Number(trimmed)
  if (Number.isFinite(numeric)) {
    return numeric > 0 && numeric < 10_000_000_000 ? numeric * 1000 : numeric
  }
  const parsed = Date.parse(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

function getTimestamp(state: Record<string, unknown>): number | undefined {
  for (const key of TIMESTAMP_KEYS) {
    const parsed = parseTimestamp(state[key])
    if (parsed !== undefined) return parsed
  }
  return undefined
}

export function extractProductPriceState(
  state: unknown
): ProductPriceState | null {
  if (!isRecord(state)) return null

  const url = getString(state, URL_KEYS)
  if (!url) return null

  const price = getPrice(state)
  if (!price) return null

  const currency =
    normalizeCurrency(getString(state, CURRENCY_KEYS)) ?? price.currency

  return {
    url,
    price: price.price,
    currency,
    observedAt: getTimestamp(state),
    name: getString(state, PRODUCT_NAME_KEYS),
    source: getString(state, SOURCE_KEYS),
  }
}

export function syncProductWatchlistFromTaskState(
  _taskId: string,
  state: unknown
): ProductWatchlistTaskStateSyncResult | null {
  const product = extractProductPriceState(state)
  if (!product) return null

  const item = addWatchlistItem({
    kind: "product",
    symbol: product.name || product.url,
    url: product.url,
    name: product.name,
    source: product.source,
    currency: product.currency,
  }).item

  return appendProductPriceObservation({
    itemIdOrSymbol: item.id,
    price: product.price,
    currency: product.currency,
    observedAt: product.observedAt,
  })
}
