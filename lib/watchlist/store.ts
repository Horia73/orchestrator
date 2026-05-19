import { randomUUID } from "crypto"

import db from "@/lib/db"
import type {
  WatchlistAlert,
  WatchlistAssetClass,
  WatchlistCandle,
  WatchlistItem,
  WatchlistItemInput,
  WatchlistItemKind,
  WatchlistQuote,
} from "./schema"

type WatchlistItemRow = {
  id: string
  kind: WatchlistItemKind
  symbol: string
  providerSymbol: string
  tradingViewSymbol: string | null
  name: string
  exchange: string | null
  currency: string | null
  assetClass: WatchlistAssetClass
  movePercent: number | null
  monitorEnabled: number | null
  sortOrder: number
  notes: string | null
  createdAt: number
  updatedAt: number
}

type WatchlistCacheRow = {
  payload: string
  updatedAt: number
}

type WatchlistAlertRow = {
  id: string
  itemId: string
  condition: "above" | "below"
  value: number
  enabled: 0 | 1
  lastTriggeredAt: number | null
  createdAt: number
  updatedAt: number
}

db.exec(`
    CREATE TABLE IF NOT EXISTS watchlist_items (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'financial',
        symbol TEXT NOT NULL,
        providerSymbol TEXT NOT NULL UNIQUE,
        tradingViewSymbol TEXT,
        name TEXT NOT NULL,
        exchange TEXT,
        currency TEXT,
        assetClass TEXT NOT NULL DEFAULT 'other',
        movePercent REAL,
        monitorEnabled INTEGER NOT NULL DEFAULT 0,
        sortOrder INTEGER NOT NULL,
        notes TEXT,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_watchlist_items_order ON watchlist_items(sortOrder, createdAt);

    CREATE TABLE IF NOT EXISTS watchlist_quote_cache (
        provider TEXT NOT NULL,
        providerSymbol TEXT NOT NULL,
        payload TEXT NOT NULL,
        updatedAt INTEGER NOT NULL,
        PRIMARY KEY(provider, providerSymbol)
    );

    CREATE TABLE IF NOT EXISTS watchlist_history_cache (
        provider TEXT NOT NULL,
        providerSymbol TEXT NOT NULL,
        range TEXT NOT NULL,
        interval TEXT NOT NULL,
        payload TEXT NOT NULL,
        updatedAt INTEGER NOT NULL,
        PRIMARY KEY(provider, providerSymbol, range, interval)
    );

    CREATE TABLE IF NOT EXISTS watchlist_alerts (
        id TEXT PRIMARY KEY,
        itemId TEXT NOT NULL,
        condition TEXT NOT NULL,
        value REAL NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        lastTriggeredAt INTEGER,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        FOREIGN KEY (itemId) REFERENCES watchlist_items(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_watchlist_alerts_item ON watchlist_alerts(itemId);
    CREATE INDEX IF NOT EXISTS idx_watchlist_alerts_enabled ON watchlist_alerts(enabled);

    CREATE TABLE IF NOT EXISTS watchlist_observations (
        id TEXT PRIMARY KEY,
        itemId TEXT NOT NULL,
        providerSymbol TEXT NOT NULL,
        price REAL,
        changePercent REAL,
        ts INTEGER NOT NULL,
        FOREIGN KEY (itemId) REFERENCES watchlist_items(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_watchlist_observations_item ON watchlist_observations(itemId, ts DESC);

    CREATE TABLE IF NOT EXISTS watchlist_migrations (
        id TEXT PRIMARY KEY,
        appliedAt INTEGER NOT NULL
    );
`)

// Migrations: per-instrument monitoring config (added after the base schema).
try {
  db.exec(`ALTER TABLE watchlist_items ADD COLUMN movePercent REAL`)
} catch {
  /* exists */
}
try {
  db.exec(
    `ALTER TABLE watchlist_items ADD COLUMN monitorEnabled INTEGER NOT NULL DEFAULT 0`
  )
} catch {
  /* exists */
}
try {
  db.exec(
    `ALTER TABLE watchlist_items ADD COLUMN kind TEXT NOT NULL DEFAULT 'financial'`
  )
} catch {
  /* exists */
}
try {
  db.exec(`ALTER TABLE watchlist_alerts ADD COLUMN itemId TEXT`)
} catch {
  /* exists */
}
try {
  db.exec(
    `UPDATE watchlist_alerts SET itemId = instrumentId WHERE itemId IS NULL AND instrumentId IS NOT NULL`
  )
} catch {
  /* legacy column absent */
}
try {
  const migrationId = "disable-default-watchlist-monitoring-v1"
  const applied = db
    .prepare("SELECT id FROM watchlist_migrations WHERE id = ?")
    .get(migrationId)
  if (!applied) {
    db.exec(`
            UPDATE watchlist_items
            SET monitorEnabled = 0
            WHERE monitorEnabled = 1
              AND movePercent IS NULL
              AND NOT EXISTS (
                SELECT 1
                FROM watchlist_alerts
                WHERE watchlist_alerts.itemId = watchlist_items.id
                  AND watchlist_alerts.enabled = 1
              )
        `)
    db.prepare(
      "INSERT INTO watchlist_migrations (id, appliedAt) VALUES (?, ?)"
    ).run(migrationId, now())
  }
} catch {
  /* best-effort cleanup for old default-enabled rows */
}

const ASSET_CLASSES = new Set<WatchlistAssetClass>([
  "stock",
  "etf",
  "crypto",
  "forex",
  "index",
  "fund",
  "other",
])

function now() {
  return Date.now()
}

function cleanOptional(value: string | null | undefined): string | null {
  const cleaned = value?.trim()
  return cleaned ? cleaned : null
}

export function normalizeProviderSymbol(value: string): string {
  const raw = value.trim()
  if (!raw) return ""
  const withoutExchange = raw.includes(":")
    ? (raw.split(":").at(-1) ?? raw)
    : raw
  return withoutExchange.replace(/\s+/g, "").toUpperCase()
}

function normalizeDisplaySymbol(value: string): string {
  return normalizeProviderSymbol(value)
}

function normalizeExchange(value: string | null | undefined): string | null {
  const cleaned = cleanOptional(value)
  if (!cleaned) return null
  return cleaned.toUpperCase().replace(/\s+/g, " ")
}

function normalizeAssetClass(
  value: WatchlistAssetClass | undefined,
  symbol: string
): WatchlistAssetClass {
  if (value && ASSET_CLASSES.has(value)) return value
  if (/^[A-Z0-9]+\/[A-Z0-9]+$/.test(symbol)) {
    const quote = symbol.split("/")[1]
    return ["USD", "USDT", "USDC", "BTC", "ETH"].includes(quote)
      ? "crypto"
      : "forex"
  }
  if (symbol.startsWith("^")) return "index"
  return "stock"
}

function compactPair(symbol: string): string {
  return symbol.replace("/", "").replace("-", "").toUpperCase()
}

export function buildTradingViewSymbol(args: {
  symbol: string
  providerSymbol?: string | null
  tradingViewSymbol?: string | null
  exchange?: string | null
  assetClass?: WatchlistAssetClass
}): string | null {
  const explicit = cleanOptional(args.tradingViewSymbol)
  if (explicit) return explicit.toUpperCase()

  const providerSymbol = normalizeProviderSymbol(
    args.providerSymbol || args.symbol
  )
  if (!providerSymbol) return null
  const assetClass =
    args.assetClass ?? normalizeAssetClass(undefined, providerSymbol)

  if (assetClass === "crypto" && providerSymbol.includes("/")) {
    return `COINBASE:${compactPair(providerSymbol)}`
  }

  if (assetClass === "forex" && providerSymbol.includes("/")) {
    return `FX:${compactPair(providerSymbol)}`
  }

  const exchange = normalizeExchange(args.exchange)
  if (exchange) {
    if (exchange.includes("NASDAQ")) return `NASDAQ:${providerSymbol}`
    if (exchange === "NYSE" || exchange.includes("NEW YORK"))
      return `NYSE:${providerSymbol}`
    if (exchange.includes("AMEX")) return `AMEX:${providerSymbol}`
    if (exchange.includes("ARCA")) return `AMEX:${providerSymbol}`
    if (exchange.includes("OTC")) return `OTC:${providerSymbol}`
  }

  return providerSymbol
}

function itemFromRow(row: WatchlistItemRow): WatchlistItem {
  return {
    id: row.id,
    kind: row.kind ?? "financial",
    symbol: row.symbol,
    providerSymbol: row.providerSymbol,
    tradingViewSymbol: row.tradingViewSymbol,
    name: row.name,
    exchange: row.exchange,
    currency: row.currency,
    assetClass: row.assetClass,
    movePercent: row.movePercent ?? null,
    monitorEnabled: row.monitorEnabled === 1,
    sortOrder: row.sortOrder,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

function parsePayload<T>(payload: string): T | null {
  try {
    return JSON.parse(payload) as T
  } catch {
    return null
  }
}

export function listWatchlistItems(): WatchlistItem[] {
  const rows = db
    .prepare(
      `
        SELECT * FROM watchlist_items
        ORDER BY sortOrder ASC, createdAt ASC
    `
    )
    .all() as WatchlistItemRow[]
  return rows.map(itemFromRow)
}

export function getWatchlistItem(idOrSymbol: string): WatchlistItem | null {
  const normalized = normalizeProviderSymbol(idOrSymbol)
  const row = db
    .prepare(
      `
        SELECT * FROM watchlist_items
        WHERE id = @value OR providerSymbol = @symbol OR symbol = @symbol
        LIMIT 1
    `
    )
    .get({ value: idOrSymbol, symbol: normalized }) as
    | WatchlistItemRow
    | undefined
  return row ? itemFromRow(row) : null
}

export function addWatchlistItem(input: WatchlistItemInput): {
  item: WatchlistItem
  created: boolean
} {
  const providerSymbol = normalizeProviderSymbol(
    input.providerSymbol || input.symbol
  )
  if (!providerSymbol) throw new Error("symbol is required")

  const existing = getWatchlistItem(providerSymbol)
  if (existing) return { item: existing, created: false }

  const assetClass = normalizeAssetClass(input.assetClass, providerSymbol)
  const exchange = normalizeExchange(input.exchange)
  const currency = cleanOptional(input.currency)?.toUpperCase() ?? null
  const createdAt = now()
  const maxSort = db
    .prepare("SELECT MAX(sortOrder) AS maxSort FROM watchlist_items")
    .get() as { maxSort: number | null }
  const item: WatchlistItem = {
    id: randomUUID(),
    kind: input.kind ?? "financial",
    symbol: normalizeDisplaySymbol(input.symbol || providerSymbol),
    providerSymbol,
    tradingViewSymbol: buildTradingViewSymbol({
      symbol: input.symbol,
      providerSymbol,
      tradingViewSymbol: input.tradingViewSymbol,
      exchange,
      assetClass,
    }),
    name: cleanOptional(input.name) ?? providerSymbol,
    exchange,
    currency,
    assetClass,
    movePercent:
      typeof input.movePercent === "number" &&
      Number.isFinite(input.movePercent)
        ? input.movePercent
        : null,
    monitorEnabled: input.monitorEnabled ?? false,
    sortOrder: (maxSort.maxSort ?? 0) + 1,
    notes: cleanOptional(input.notes),
    createdAt,
    updatedAt: createdAt,
  }

  db.prepare(
    `
        INSERT INTO watchlist_items (
            id, kind, symbol, providerSymbol, tradingViewSymbol, name, exchange, currency,
            assetClass, movePercent, monitorEnabled, sortOrder, notes, createdAt, updatedAt
        ) VALUES (
            @id, @kind, @symbol, @providerSymbol, @tradingViewSymbol, @name, @exchange, @currency,
            @assetClass, @movePercent, @monitorEnabled, @sortOrder, @notes, @createdAt, @updatedAt
        )
    `
  ).run({ ...item, monitorEnabled: item.monitorEnabled ? 1 : 0 })

  return { item, created: true }
}

export function removeWatchlistItem(idOrSymbol: string): boolean {
  const normalized = normalizeProviderSymbol(idOrSymbol)
  const result = db
    .prepare(
      `
        DELETE FROM watchlist_items
        WHERE id = @value OR providerSymbol = @symbol OR symbol = @symbol
    `
    )
    .run({ value: idOrSymbol, symbol: normalized })
  return result.changes > 0
}

export function updateWatchlistItem(
  id: string,
  patch: Partial<
    Pick<
      WatchlistItem,
      | "name"
      | "tradingViewSymbol"
      | "notes"
      | "sortOrder"
      | "movePercent"
      | "monitorEnabled"
    >
  >
): WatchlistItem | null {
  const existing = getWatchlistItem(id)
  if (!existing) return null
  const updated = {
    ...existing,
    name: cleanOptional(patch.name) ?? existing.name,
    tradingViewSymbol:
      patch.tradingViewSymbol === undefined
        ? existing.tradingViewSymbol
        : cleanOptional(patch.tradingViewSymbol),
    notes:
      patch.notes === undefined ? existing.notes : cleanOptional(patch.notes),
    sortOrder:
      typeof patch.sortOrder === "number" && Number.isFinite(patch.sortOrder)
        ? patch.sortOrder
        : existing.sortOrder,
    movePercent:
      patch.movePercent === undefined
        ? existing.movePercent
        : typeof patch.movePercent === "number" &&
            Number.isFinite(patch.movePercent)
          ? patch.movePercent
          : null,
    monitorEnabled: patch.monitorEnabled ?? existing.monitorEnabled,
    updatedAt: now(),
  }
  db.prepare(
    `
        UPDATE watchlist_items
        SET name = @name,
            tradingViewSymbol = @tradingViewSymbol,
            notes = @notes,
            sortOrder = @sortOrder,
            movePercent = @movePercent,
            monitorEnabled = @monitorEnabled,
            updatedAt = @updatedAt
        WHERE id = @id
    `
  ).run({ ...updated, monitorEnabled: updated.monitorEnabled ? 1 : 0 })
  return updated
}

export function readQuoteCache(
  provider: string,
  providerSymbol: string
): { quote: WatchlistQuote; updatedAt: number } | null {
  const row = db
    .prepare(
      `
        SELECT payload, updatedAt FROM watchlist_quote_cache
        WHERE provider = ? AND providerSymbol = ?
    `
    )
    .get(provider, normalizeProviderSymbol(providerSymbol)) as
    | WatchlistCacheRow
    | undefined
  if (!row) return null
  const quote = parsePayload<WatchlistQuote>(row.payload)
  return quote ? { quote, updatedAt: row.updatedAt } : null
}

export function writeQuoteCache(provider: string, quote: WatchlistQuote): void {
  db.prepare(
    `
        INSERT INTO watchlist_quote_cache (provider, providerSymbol, payload, updatedAt)
        VALUES (@provider, @providerSymbol, @payload, @updatedAt)
        ON CONFLICT(provider, providerSymbol) DO UPDATE SET
            payload = excluded.payload,
            updatedAt = excluded.updatedAt
    `
  ).run({
    provider,
    providerSymbol: normalizeProviderSymbol(quote.providerSymbol),
    payload: JSON.stringify(quote),
    updatedAt: now(),
  })
}

export function readHistoryCache(
  provider: string,
  providerSymbol: string,
  range: string,
  interval: string
): { candles: WatchlistCandle[]; updatedAt: number } | null {
  const row = db
    .prepare(
      `
        SELECT payload, updatedAt FROM watchlist_history_cache
        WHERE provider = ? AND providerSymbol = ? AND range = ? AND interval = ?
    `
    )
    .get(provider, normalizeProviderSymbol(providerSymbol), range, interval) as
    | WatchlistCacheRow
    | undefined
  if (!row) return null
  const candles = parsePayload<WatchlistCandle[]>(row.payload)
  return candles ? { candles, updatedAt: row.updatedAt } : null
}

export function writeHistoryCache(
  provider: string,
  providerSymbol: string,
  range: string,
  interval: string,
  candles: WatchlistCandle[]
): void {
  db.prepare(
    `
        INSERT INTO watchlist_history_cache (provider, providerSymbol, range, interval, payload, updatedAt)
        VALUES (@provider, @providerSymbol, @range, @interval, @payload, @updatedAt)
        ON CONFLICT(provider, providerSymbol, range, interval) DO UPDATE SET
            payload = excluded.payload,
            updatedAt = excluded.updatedAt
    `
  ).run({
    provider,
    providerSymbol: normalizeProviderSymbol(providerSymbol),
    range,
    interval,
    payload: JSON.stringify(candles),
    updatedAt: now(),
  })
}

export function listWatchlistAlerts(itemId?: string): WatchlistAlert[] {
  const rows = itemId
    ? db
        .prepare(
          "SELECT * FROM watchlist_alerts WHERE itemId = ? ORDER BY createdAt ASC"
        )
        .all(itemId)
    : db.prepare("SELECT * FROM watchlist_alerts ORDER BY createdAt ASC").all()
  return (rows as WatchlistAlertRow[]).map((row) => ({
    id: row.id,
    itemId: row.itemId,
    condition: row.condition,
    value: row.value,
    enabled: row.enabled === 1,
    lastTriggeredAt: row.lastTriggeredAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }))
}

export function hasActiveWatchlistMonitoring(): boolean {
  const row = db
    .prepare(
      `
        SELECT
          (
            SELECT COUNT(*)
            FROM watchlist_items
            WHERE monitorEnabled = 1
          ) AS monitoredItems,
          (
            SELECT COUNT(*)
            FROM watchlist_alerts
            WHERE enabled = 1
          ) AS enabledAlerts
    `
    )
    .get() as { monitoredItems: number; enabledAlerts: number } | undefined
  return Boolean(row && (row.monitoredItems > 0 || row.enabledAlerts > 0))
}
