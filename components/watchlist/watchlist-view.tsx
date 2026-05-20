"use client"

import Image from "next/image"
import * as React from "react"
import {
  AlertCircle,
  ArrowLeft,
  Bell,
  Check,
  ExternalLink,
  LineChart,
  Loader2,
  Package,
  Pencil,
  Plus,
  RefreshCcw,
  Search,
  Sparkles,
  Trash2,
  TrendingDown,
  TrendingUp,
} from "lucide-react"
import { Area, AreaChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"
import type {
  WatchlistCandle,
  WatchlistDataStatus,
  WatchlistItemWithQuote,
  WatchlistRange,
  WatchlistSearchResult,
} from "@/lib/watchlist/schema"
import { TradingViewChart } from "./tradingview-chart"

type WatchlistResponse = {
  status: WatchlistDataStatus
  items: WatchlistItemWithQuote[]
  errors?: string[]
}

type HistoryResponse = {
  status: WatchlistDataStatus
  candles: WatchlistCandle[]
  updatedAt: number | null
  stale: boolean
  interval: string
  error?: string
}

type SearchResponse = {
  status: WatchlistDataStatus
  results: WatchlistSearchResult[]
  error?: string
}

type ProductAddInput = {
  kind: "product"
  url?: string
  name?: string
  source?: string
  currency?: string
  price?: number
  imageUrl?: string
}

type ProductMetadata = {
  url: string
  name: string | null
  price: number | null
  currency: string | null
  image: string | null
  store: string | null
  description: string | null
}

type ProductMetadataResponse = {
  metadata?: ProductMetadata
  error?: string
}

type AddWatchlistInput =
  | WatchlistSearchResult
  | { symbol: string }
  | ProductAddInput

type HistoryChartPoint = WatchlistCandle & {
  label: string
}

function isProductAddInput(item: AddWatchlistInput): item is ProductAddInput {
  return "kind" in item && item.kind === "product"
}

const RANGES: WatchlistRange[] = ["1D", "5D", "1M", "6M", "1Y"]
const AUTO_REFRESH_MS = 10 * 60 * 1000

function formatPrice(
  value: number | null | undefined,
  currency?: string | null
) {
  if (value == null || !Number.isFinite(value)) return "—"
  const abs = Math.abs(value)
  const digits = abs >= 100 ? 2 : abs >= 1 ? 3 : 6
  try {
    if (currency && /^[A-Z]{3}$/.test(currency)) {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency,
        maximumFractionDigits: digits,
      }).format(value)
    }
  } catch {
    // Fall through to plain numeric formatting for unusual currency codes.
  }
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: digits,
  }).format(value)
}

function formatCompact(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—"
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value)
}

function formatSigned(value: number | null | undefined, suffix = "") {
  if (value == null || !Number.isFinite(value)) return "—"
  const sign = value > 0 ? "+" : ""
  return `${sign}${value.toFixed(2)}${suffix}`
}

function formatTime(value: number | null | undefined) {
  if (!value) return "Never"
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value)
}

async function responseError(res: Response): Promise<string> {
  try {
    const data = await res.json()
    return typeof data.error === "string"
      ? data.error
      : `Request failed (${res.status})`
  } catch {
    return `Request failed (${res.status})`
  }
}

function changeTone(value: number | null | undefined) {
  if (value == null || value === 0) return "text-foreground/55"
  return value > 0
    ? "text-emerald-600 dark:text-emerald-400"
    : "text-[#802020] dark:text-red-300"
}

function AssetBadge({ value }: { value: string }) {
  return (
    <span className="rounded bg-muted px-1.5 py-0.5 text-[10.5px] font-medium tracking-wide text-foreground/50 uppercase">
      {value}
    </span>
  )
}

function itemTitle(item: WatchlistItemWithQuote) {
  return item.kind === "product" ? item.name : item.symbol
}

function itemSubtitle(item: WatchlistItemWithQuote) {
  if (item.kind === "product") {
    return item.exchange || item.url || item.providerSymbol
  }
  return item.name
}

function itemBadge(item: WatchlistItemWithQuote) {
  return item.kind === "product" ? "product" : item.assetClass
}

function ProviderStatus({
  status,
  errors,
  show,
}: {
  status: WatchlistDataStatus | null
  errors: string[]
  show: boolean
}) {
  if (!show) return null
  if (!status && errors.length === 0) return null
  if (status?.configured && errors.length === 0) return null
  return (
    <div className="flex items-start gap-2 border-b border-border/60 bg-amber-50/70 px-4 py-2.5 text-[12.5px] text-amber-800 dark:bg-amber-950/35 dark:text-amber-200">
      <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0">
        {!status?.configured && (
          <p>
            {status?.message ?? "Financial data provider is not configured."}
          </p>
        )}
        {errors.map((error, index) => (
          <p key={`${error}-${index}`}>{error}</p>
        ))}
      </div>
    </div>
  )
}

function WatchlistRow({
  item,
  selected,
  onSelect,
  onRemove,
}: {
  item: WatchlistItemWithQuote
  selected: boolean
  onSelect: () => void
  onRemove: () => void
}) {
  const q = item.quote
  const change = q?.changePercent ?? null
  const positive = change != null && change > 0
  const isProduct = item.kind === "product"
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          onSelect()
        }
      }}
      className={cn(
        "group flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none",
        selected
          ? "bg-[#f0ede6] dark:bg-muted"
          : "hover:bg-[#f0ede6]/60 dark:hover:bg-muted/60"
      )}
    >
      {isProduct && (
        <ProductThumbnail
          src={item.imageUrl}
          alt={item.name}
          size={36}
          className="ring-border/30"
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-[13.5px] font-semibold text-foreground">
            {itemTitle(item)}
          </span>
          {!isProduct && <AssetBadge value={itemBadge(item)} />}
        </div>
        <div className="truncate text-[11.5px] text-foreground/45">
          {isProduct
            ? item.exchange || itemSubtitle(item) || "Tracked product"
            : itemSubtitle(item)}
        </div>
      </div>
      <div className="shrink-0 text-right tabular-nums">
        <div className="text-[13px] font-medium text-foreground/85">
          {formatPrice(q?.price, q?.currency ?? item.currency)}
        </div>
        <div className="text-[11.5px] text-foreground/45">
          {isProduct
            ? formatTime(q?.timestamp ?? item.quoteUpdatedAt)
            : `open ${formatPrice(q?.open, q?.currency ?? item.currency)}`}
        </div>
      </div>
      <div
        className={cn(
          "flex w-[68px] shrink-0 items-center justify-end gap-1 text-right text-[12.5px] font-medium tabular-nums",
          changeTone(change)
        )}
      >
        {positive ? (
          <TrendingUp className="size-3" />
        ) : change != null && change < 0 ? (
          <TrendingDown className="size-3" />
        ) : null}
        {formatSigned(change, "%")}
      </div>
      <button
        type="button"
        title="Remove"
        onClick={(event) => {
          event.stopPropagation()
          onRemove()
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault()
            event.stopPropagation()
            onRemove()
          }
        }}
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-foreground/30 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-red-50 hover:text-[#802020] focus:opacity-100"
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  )
}

function ListSectionHeader({
  label,
  count,
}: {
  label: string
  count: number
}) {
  return (
    <div className="mt-1 mb-0.5 flex items-center gap-2 px-2.5 pt-2 text-[10.5px] font-semibold tracking-wider text-foreground/40 uppercase">
      <span>{label}</span>
      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-foreground/45">
        {count}
      </span>
    </div>
  )
}

function ProductThumbnail({
  src,
  alt,
  size = 40,
  className,
}: {
  src: string | null | undefined
  alt: string
  size?: number
  className?: string
}) {
  const [errored, setErrored] = React.useState(false)
  const dimension = `${size}px`
  if (!src || errored) {
    return (
      <div
        className={cn(
          "flex shrink-0 items-center justify-center rounded-md bg-muted text-foreground/35",
          className
        )}
        style={{ width: dimension, height: dimension }}
      >
        <Package className="size-1/2" />
      </div>
    )
  }
  return (
    <Image
      src={src}
      alt={alt}
      width={size}
      height={size}
      unoptimized
      loading="lazy"
      onError={() => setErrored(true)}
      className={cn(
        "shrink-0 rounded-md bg-muted object-cover ring-1 ring-border/40",
        className
      )}
      style={{ width: dimension, height: dimension }}
    />
  )
}

function InstrumentSearch({
  onAdd,
}: {
  onAdd: (item: AddWatchlistInput) => Promise<void>
}) {
  const [query, setQuery] = React.useState("")
  const [results, setResults] = React.useState<WatchlistSearchResult[]>([])
  const [loading, setLoading] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [adding, setAdding] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    if (!query.trim()) {
      setResults([])
      setLoading(false)
      setError(null)
      return () => {
        cancelled = true
      }
    }
    const handle = window.setTimeout(async () => {
      setLoading(true)
      try {
        const res = await fetch(
          `/api/watchlist/search?q=${encodeURIComponent(query)}`,
          { cache: "no-store" }
        )
        if (!res.ok) throw new Error(await responseError(res))
        const data = (await res.json()) as SearchResponse
        if (!cancelled) {
          setResults(Array.isArray(data.results) ? data.results : [])
          setError(data.error ?? null)
        }
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Search failed")
      } finally {
        if (!cancelled) setLoading(false)
      }
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(handle)
    }
  }, [query])

  const add = async (item: WatchlistSearchResult | { symbol: string }) => {
    const key = "providerSymbol" in item ? item.providerSymbol : item.symbol
    setAdding(key)
    try {
      await onAdd(item)
      setQuery("")
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Add failed")
    } finally {
      setAdding(null)
    }
  }

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-foreground/35" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && query.trim()) {
              event.preventDefault()
              void add({ symbol: query.trim() })
            }
          }}
          placeholder="Search AAPL, BTC/USD..."
          className="h-9 pr-8 pl-8 text-[13px]"
          autoFocus
        />
        {loading && (
          <Loader2 className="absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 animate-spin text-foreground/35" />
        )}
      </div>
      {error && (
        <p className="text-[11.5px] text-amber-700 dark:text-amber-300">
          {error}
        </p>
      )}
      <div className="max-h-[230px] overflow-y-auto">
        {results.map((item) => (
          <button
            key={`${item.providerSymbol}-${item.exchange ?? ""}`}
            type="button"
            onClick={() => void add(item)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[#f0ede6]/70 dark:hover:bg-muted"
          >
            <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-foreground/55">
              {adding === item.providerSymbol ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Plus className="size-3" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="text-[12.5px] font-semibold">
                  {item.symbol}
                </span>
                <AssetBadge value={item.assetClass} />
              </span>
              <span className="block truncate text-[11.5px] text-foreground/45">
                {item.name}
                {item.exchange ? ` · ${item.exchange}` : ""}
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

type ProductDraft = {
  url: string
  name: string
  source: string
  price: string
  currency: string
  imageUrl: string | null
}

function emptyDraft(): ProductDraft {
  return {
    url: "",
    name: "",
    source: "",
    price: "",
    currency: "EUR",
    imageUrl: null,
  }
}

function ProductAdd({
  onAdd,
}: {
  onAdd: (item: AddWatchlistInput) => Promise<void>
}) {
  type Step = "url" | "fetching" | "preview" | "manual"
  const [step, setStep] = React.useState<Step>("url")
  const [draft, setDraft] = React.useState<ProductDraft>(emptyDraft)
  const [error, setError] = React.useState<string | null>(null)
  const [info, setInfo] = React.useState<string | null>(null)
  const [adding, setAdding] = React.useState(false)

  const reset = () => {
    setDraft(emptyDraft())
    setStep("url")
    setError(null)
    setInfo(null)
  }

  const fetchMetadata = async (rawUrl: string) => {
    const url = rawUrl.trim()
    if (!url) {
      setError("Paste a product URL first")
      return
    }
    setError(null)
    setInfo(null)
    setStep("fetching")
    try {
      const res = await fetch(
        `/api/watchlist/product-metadata?url=${encodeURIComponent(url)}`,
        { cache: "no-store" }
      )
      const data = (await res.json()) as ProductMetadataResponse
      if (!res.ok) {
        setStep("manual")
        setDraft((previous) => ({ ...previous, url }))
        setError(
          data.error
            ? `Couldn't auto-detect from this page (${data.error}). Fill in manually below.`
            : "Couldn't auto-detect from this page. Fill in manually below."
        )
        return
      }
      const meta = data.metadata
      if (!meta) {
        setStep("manual")
        setDraft((previous) => ({ ...previous, url }))
        setError("No product details detected. Fill in manually below.")
        return
      }
      const sourceLabel = meta.store ?? ""
      const next: ProductDraft = {
        url: meta.url || url,
        name: meta.name ?? "",
        source: sourceLabel,
        price: meta.price != null ? String(meta.price) : "",
        currency: meta.currency ?? "EUR",
        imageUrl: meta.image ?? null,
      }
      setDraft(next)
      const missing: string[] = []
      if (!next.name) missing.push("name")
      if (!next.price) missing.push("price")
      if (missing.length > 0) {
        setInfo(`Detected partial info — review ${missing.join(" and ")} before adding.`)
      } else {
        setInfo(null)
      }
      setStep("preview")
    } catch (err) {
      setStep("manual")
      setDraft((previous) => ({ ...previous, url }))
      setError(err instanceof Error ? err.message : "Failed to fetch")
    }
  }

  const commit = async () => {
    const url = draft.url.trim()
    const name = draft.name.trim()
    const source = draft.source.trim()
    const currency = draft.currency.trim().toUpperCase()
    const normalizedPrice = draft.price.trim().replace(",", ".")
    const price = normalizedPrice ? Number(normalizedPrice) : undefined
    if (!url && !name) {
      setError("Product URL or name is required")
      return
    }
    if (price !== undefined && !Number.isFinite(price)) {
      setError("Price must be a number")
      return
    }
    setAdding(true)
    setError(null)
    try {
      await onAdd({
        kind: "product",
        url: url || undefined,
        name: name || undefined,
        source: source || undefined,
        currency: currency || undefined,
        price,
        imageUrl: draft.imageUrl || undefined,
      })
      reset()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Add failed")
    } finally {
      setAdding(false)
    }
  }

  const updateDraft = (patch: Partial<ProductDraft>) =>
    setDraft((prev) => ({ ...prev, ...patch }))

  if (step === "url" || step === "fetching") {
    return (
      <div className="space-y-2">
        <label className="block text-[11px] font-medium tracking-wide text-foreground/55 uppercase">
          Paste product URL
        </label>
        <div className="flex gap-2">
          <Input
            value={draft.url}
            onChange={(event) =>
              updateDraft({ url: event.target.value })
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                void fetchMetadata(draft.url)
              }
            }}
            placeholder="https://shop.example.com/product/123"
            className="h-9 flex-1 text-[13px]"
            autoFocus
            disabled={step === "fetching"}
          />
          <Button
            type="button"
            size="sm"
            onClick={() => void fetchMetadata(draft.url)}
            disabled={step === "fetching" || !draft.url.trim()}
            className="h-9 gap-1.5 whitespace-nowrap"
          >
            {step === "fetching" ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Reading…
              </>
            ) : (
              <>
                <Sparkles className="size-3.5" />
                Track
              </>
            )}
          </Button>
        </div>
        <p className="text-[11.5px] text-foreground/45">
          We&apos;ll detect name, price and image automatically.
        </p>
        <button
          type="button"
          onClick={() => {
            setStep("manual")
            setError(null)
          }}
          className="text-[11.5px] text-foreground/55 underline-offset-2 hover:text-foreground hover:underline"
        >
          Or enter details manually
        </button>
        {error && (
          <p className="text-[11.5px] text-amber-700 dark:text-amber-300">
            {error}
          </p>
        )}
      </div>
    )
  }

  if (step === "preview") {
    return (
      <div className="space-y-3">
        <div className="flex items-start gap-3 rounded-lg border border-border/60 bg-card p-2.5">
          <ProductThumbnail
            src={draft.imageUrl}
            alt={draft.name || "Product"}
            size={56}
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-semibold text-foreground/90">
              {draft.name || "Unnamed product"}
            </div>
            <div className="mt-0.5 truncate text-[11.5px] text-foreground/55">
              {draft.source || "Unknown store"}
            </div>
            <div className="mt-1 text-[14px] font-semibold tabular-nums text-foreground">
              {draft.price ? (
                <>
                  {draft.price}{" "}
                  <span className="text-[11.5px] font-medium text-foreground/55">
                    {draft.currency}
                  </span>
                </>
              ) : (
                <span className="text-[12px] font-normal text-foreground/45">
                  Price not detected
                </span>
              )}
            </div>
          </div>
        </div>
        {info && (
          <p className="text-[11.5px] text-foreground/55">{info}</p>
        )}
        {error && (
          <p className="text-[11.5px] text-amber-700 dark:text-amber-300">
            {error}
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            onClick={() => void commit()}
            disabled={adding}
            className="h-9 flex-1 gap-1.5"
          >
            {adding ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Plus className="size-3.5" />
            )}
            Add to watchlist
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setStep("manual")}
            className="h-9 gap-1.5"
            title="Edit details"
          >
            <Pencil className="size-3.5" />
            Edit
          </Button>
          <button
            type="button"
            onClick={reset}
            className="text-[11.5px] text-foreground/55 underline-offset-2 hover:text-foreground hover:underline"
          >
            Cancel
          </button>
        </div>
      </div>
    )
  }

  // Manual fallback.
  return (
    <div className="space-y-2">
      <Input
        value={draft.url}
        onChange={(event) => updateDraft({ url: event.target.value })}
        placeholder="Product URL"
        className="h-9 text-[13px]"
      />
      <Input
        value={draft.name}
        onChange={(event) => updateDraft({ name: event.target.value })}
        placeholder="Product name"
        className="h-9 text-[13px]"
        autoFocus
      />
      <Input
        value={draft.imageUrl ?? ""}
        onChange={(event) =>
          updateDraft({ imageUrl: event.target.value || null })
        }
        placeholder="Image URL (optional)"
        className="h-9 text-[13px]"
      />
      <div className="grid grid-cols-[minmax(0,1fr)_84px] gap-2">
        <Input
          value={draft.price}
          onChange={(event) => updateDraft({ price: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              void commit()
            }
          }}
          inputMode="decimal"
          placeholder="Price"
          className="h-9 text-[13px]"
        />
        <Input
          value={draft.currency}
          onChange={(event) =>
            updateDraft({ currency: event.target.value })
          }
          placeholder="EUR"
          className="h-9 text-[13px] uppercase"
        />
      </div>
      <Input
        value={draft.source}
        onChange={(event) => updateDraft({ source: event.target.value })}
        placeholder="Store / source"
        className="h-9 text-[13px]"
      />
      {error && (
        <p className="text-[11.5px] text-amber-700 dark:text-amber-300">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          onClick={() => void commit()}
          disabled={adding}
          className="h-9 flex-1 gap-1.5"
        >
          {adding ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Plus className="size-3.5" />
          )}
          Add product
        </Button>
        <button
          type="button"
          onClick={() => {
            setStep("url")
            setError(null)
          }}
          className="text-[11.5px] text-foreground/55 underline-offset-2 hover:text-foreground hover:underline"
        >
          Back
        </button>
      </div>
    </div>
  )
}

function SearchAdd({
  onAdd,
}: {
  onAdd: (item: AddWatchlistInput) => Promise<void>
}) {
  const [mode, setMode] = React.useState<"financial" | "product">("financial")
  return (
    <div className="border-b border-border/60 px-3 pb-3">
      <div className="mb-2 inline-flex h-8 rounded-lg bg-muted/60 p-0.5">
        {(["financial", "product"] as const).map((item) => (
          <button
            key={item}
            type="button"
            onClick={() => setMode(item)}
            className={cn(
              "rounded-md px-2.5 text-[12px] font-medium transition-colors",
              mode === item
                ? "bg-card text-foreground shadow-sm ring-1 ring-border/50"
                : "text-foreground/50 hover:text-foreground"
            )}
          >
            {item === "financial" ? "Instrument" : "Product"}
          </button>
        ))}
      </div>
      {mode === "financial" ? (
        <InstrumentSearch onAdd={onAdd} />
      ) : (
        <ProductAdd onAdd={onAdd} />
      )}
    </div>
  )
}

function HistoryAreaChart({
  data,
  currency,
}: {
  data: HistoryChartPoint[]
  currency?: string | null
}) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = React.useState(0)

  React.useEffect(() => {
    const node = containerRef.current
    if (!node) return
    const updateWidth = (value: number) => {
      setWidth(Math.max(0, Math.floor(value)))
    }
    updateWidth(node.getBoundingClientRect().width)
    const observer = new ResizeObserver((entries) => {
      updateWidth(entries[0]?.contentRect.width ?? 0)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  return (
    <div ref={containerRef} className="h-[170px] min-w-0">
      {width > 0 && (
        <AreaChart
          width={width}
          height={170}
          data={data}
          margin={{ top: 6, right: 8, left: -18, bottom: 0 }}
        >
          <defs>
            <linearGradient id="watchlistHistory" x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="5%"
                stopColor="var(--color-chart-2)"
                stopOpacity={0.28}
              />
              <stop
                offset="95%"
                stopColor="var(--color-chart-2)"
                stopOpacity={0.02}
              />
            </linearGradient>
          </defs>
          <CartesianGrid
            strokeDasharray="3 3"
            vertical={false}
            stroke="var(--border)"
          />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            minTickGap={28}
          />
          <YAxis
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            domain={["auto", "auto"]}
          />
          <Tooltip
            contentStyle={{
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "var(--card)",
              color: "var(--foreground)",
              fontSize: 12,
            }}
            formatter={(value) => [
              formatPrice(
                typeof value === "number" ? value : Number(value),
                currency
              ),
              "Close",
            ]}
            labelFormatter={(_, payload) => payload?.[0]?.payload?.time ?? ""}
          />
          <Area
            type="monotone"
            dataKey="close"
            stroke="var(--color-chart-2)"
            strokeWidth={2}
            fill="url(#watchlistHistory)"
            dot={false}
          />
        </AreaChart>
      )}
    </div>
  )
}

function HistoryPreview({
  selected,
}: {
  selected: WatchlistItemWithQuote | null
}) {
  const [range, setRange] = React.useState<WatchlistRange>("1M")
  const [data, setData] = React.useState<HistoryResponse | null>(null)
  const [loading, setLoading] = React.useState(false)

  React.useEffect(() => {
    if (!selected) {
      setData(null)
      return
    }
    let cancelled = false
    const load = async () => {
      setLoading(true)
      try {
        const res = await fetch(
          `/api/watchlist/history?itemId=${encodeURIComponent(selected.id)}&range=${range}`,
          { cache: "no-store" }
        )
        if (!res.ok) throw new Error(await responseError(res))
        const result = (await res.json()) as HistoryResponse
        if (!cancelled) setData(result)
      } catch (error) {
        if (!cancelled) {
          setData({
            status: { provider: "twelve-data", configured: false },
            candles: [],
            updatedAt: null,
            stale: true,
            interval: "",
            error: error instanceof Error ? error.message : "History failed",
          })
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [selected, range])

  const chartData = React.useMemo(() => {
    return (data?.candles ?? []).map((candle) => ({
      ...candle,
      label:
        range === "1D"
          ? new Intl.DateTimeFormat(undefined, {
              hour: "2-digit",
              minute: "2-digit",
            }).format(candle.timestamp)
          : new Intl.DateTimeFormat(undefined, {
              month: "short",
              day: "numeric",
            }).format(candle.timestamp),
    }))
  }, [data?.candles, range])

  return (
    <section className="min-h-[230px] min-w-0 border-t border-border/60 px-4 py-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <LineChart className="size-4 text-foreground/45" />
          <h2 className="text-[14px] font-semibold text-foreground/80">
            {selected?.kind === "product"
              ? "Price history"
              : "Provider history"}
          </h2>
          {loading && (
            <Loader2 className="size-3.5 animate-spin text-foreground/35" />
          )}
        </div>
        <div className="inline-flex h-8 rounded-lg bg-muted/60 p-0.5">
          {RANGES.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setRange(item)}
              className={cn(
                "rounded-md px-2.5 text-[12px] font-medium transition-colors",
                range === item
                  ? "bg-card text-foreground shadow-sm ring-1 ring-border/50"
                  : "text-foreground/50 hover:text-foreground"
              )}
            >
              {item}
            </button>
          ))}
        </div>
      </div>

      {data?.error && (
        <div className="mb-2 rounded-md bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:bg-amber-950/35 dark:text-amber-200">
          {data.error}
        </div>
      )}

      {chartData.length > 1 ? (
        <HistoryAreaChart data={chartData} currency={selected?.currency} />
      ) : (
        <div className="flex h-[170px] items-center justify-center rounded-lg border border-dashed border-border/70 text-[13px] text-foreground/45">
          {selected
            ? selected.kind === "product"
              ? "No price observations yet."
              : "No cached history yet."
            : "Select an item."}
        </div>
      )}
    </section>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: string
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border/60 bg-card px-3 py-2">
      <div className="text-[11px] tracking-wide text-foreground/40 uppercase">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 truncate text-[14px] font-semibold text-foreground/80 tabular-nums",
          tone
        )}
      >
        {value}
      </div>
    </div>
  )
}

export function WatchlistView() {
  const [items, setItems] = React.useState<WatchlistItemWithQuote[]>([])
  const [status, setStatus] = React.useState<WatchlistDataStatus | null>(null)
  const [errors, setErrors] = React.useState<string[]>([])
  const [loading, setLoading] = React.useState(true)
  const [refreshing, setRefreshing] = React.useState(false)
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [mobileDetailOpen, setMobileDetailOpen] = React.useState(false)

  const selected = React.useMemo(() => {
    return items.find((item) => item.id === selectedId) ?? items[0] ?? null
  }, [items, selectedId])

  const { financialItems, productItems, headerSummary } = React.useMemo(() => {
    const financials = items.filter((item) => item.kind === "financial")
    const products = items.filter((item) => item.kind === "product")
    const parts: string[] = []
    if (financials.length > 0)
      parts.push(`${financials.length} ${financials.length === 1 ? "instrument" : "instruments"}`)
    if (products.length > 0)
      parts.push(`${products.length} ${products.length === 1 ? "product" : "products"}`)
    return {
      financialItems: financials,
      productItems: products,
      headerSummary: parts.length > 0 ? parts.join(" · ") : "Empty",
    }
  }, [items])

  const hasFinancialItems = financialItems.length > 0

  const load = React.useCallback(async (force = false) => {
    setRefreshing(force)
    try {
      const res = await fetch(
        `/api/watchlist/items?force=${force ? "1" : "0"}`,
        { cache: "no-store" }
      )
      if (!res.ok) throw new Error(await responseError(res))
      const data = (await res.json()) as WatchlistResponse
      setItems(Array.isArray(data.items) ? data.items : [])
      setStatus(data.status ?? null)
      setErrors(Array.isArray(data.errors) ? data.errors : [])
    } catch (error) {
      setErrors([
        error instanceof Error ? error.message : "Failed to load watchlist",
      ])
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  React.useEffect(() => {
    void load(false)
    const tick = () => {
      if (document.visibilityState === "visible") void load(false)
    }
    const interval = window.setInterval(tick, AUTO_REFRESH_MS)
    document.addEventListener("visibilitychange", tick)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", tick)
    }
  }, [load])

  React.useEffect(() => {
    if (!selectedId && items[0]) setSelectedId(items[0].id)
    if (
      selectedId &&
      items.length > 0 &&
      !items.some((item) => item.id === selectedId)
    ) {
      setSelectedId(items[0].id)
    }
  }, [items, selectedId])

  React.useEffect(() => {
    if (!selected) setMobileDetailOpen(false)
  }, [selected])

  const addItem = React.useCallback(
    async (instrument: AddWatchlistInput) => {
      let body: AddWatchlistInput
      if (isProductAddInput(instrument)) {
        body = instrument
      } else if ("providerSymbol" in instrument) {
        body = instrument
      } else {
        body = { symbol: instrument.symbol }
      }
      const res = await fetch("/api/watchlist/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(await responseError(res))
      const result = (await res.json()) as { item?: { id: string } }
      await load(true)
      if (result.item?.id) setSelectedId(result.item.id)
    },
    [load]
  )

  const removeInstrument = React.useCallback(
    async (id: string) => {
      const res = await fetch(
        `/api/watchlist/items/${encodeURIComponent(id)}`,
        { method: "DELETE" }
      )
      if (!res.ok) throw new Error(await responseError(res))
      await load(false)
    },
    [load]
  )

  const tvWatchlist = React.useMemo(() => {
    return items
      .filter((item) => item.kind === "financial")
      .map((item) => item.tradingViewSymbol || item.symbol)
      .filter(Boolean)
  }, [items])

  const q = selected?.quote
  const chartSymbol =
    selected?.tradingViewSymbol || selected?.symbol || "NASDAQ:AAPL"
  const selectedIsProduct = selected?.kind === "product"
  const productPageUrl =
    selectedIsProduct && selected?.url?.startsWith("http") ? selected.url : null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-border/60 px-4 pt-[calc(0.75rem+env(safe-area-inset-top))] pb-3 md:pt-3">
        <SidebarTrigger className="size-10 text-foreground/55 hover:text-foreground md:hidden" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-[18px] font-semibold tracking-tight text-foreground/90">
              Watchlist
            </h1>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground/50">
              {headerSummary}
            </span>
          </div>
          <p className="mt-0.5 text-[12px] text-foreground/45">
            Tracked instruments and product prices.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void load(true)}
          disabled={refreshing}
          title="Refresh quotes"
          className="gap-1.5"
        >
          {refreshing ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCcw className="size-3.5" />
          )}
          <span className="hidden sm:inline">Refresh</span>
        </Button>
      </header>

      <ProviderStatus
        status={status}
        errors={errors}
        show={hasFinancialItems || (!status && errors.length > 0)}
      />

      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[390px_minmax(0,1fr)]">
        <aside
          className={cn(
            "min-h-0 flex-col border-r border-border/60 md:flex",
            mobileDetailOpen ? "hidden md:flex" : "flex"
          )}
        >
          <div className="px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-[13px] font-semibold tracking-wide text-foreground/45 uppercase">
                Watchlist
              </h2>
              {loading && (
                <Loader2 className="size-3.5 animate-spin text-foreground/35" />
              )}
            </div>
          </div>
          <SearchAdd onAdd={addItem} />
          <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
            {loading && items.length === 0 ? (
              <div className="space-y-2 px-2">
                {[1, 2, 3, 4].map((i) => (
                  <div
                    key={i}
                    className="h-[58px] animate-pulse rounded-lg bg-muted/50"
                  />
                ))}
              </div>
            ) : items.length === 0 ? (
              <div className="px-4 py-12 text-center">
                <div className="mx-auto flex size-10 items-center justify-center rounded-lg bg-muted">
                  <LineChart className="size-5 text-foreground/40" />
                </div>
                <p className="mt-3 text-[13px] font-medium text-foreground/70">
                  No items yet
                </p>
                <p className="mt-1 text-[12px] text-foreground/45">
                  Search above or add a product.
                </p>
              </div>
            ) : (
              <div className="space-y-0.5 pb-2">
                {financialItems.length > 0 && (
                  <>
                    <ListSectionHeader
                      label="Instruments"
                      count={financialItems.length}
                    />
                    {financialItems.map((item) => (
                      <WatchlistRow
                        key={item.id}
                        item={item}
                        selected={selected?.id === item.id}
                        onSelect={() => {
                          setSelectedId(item.id)
                          setMobileDetailOpen(true)
                        }}
                        onRemove={() => void removeInstrument(item.id)}
                      />
                    ))}
                  </>
                )}
                {productItems.length > 0 && (
                  <>
                    <ListSectionHeader
                      label="Products"
                      count={productItems.length}
                    />
                    {productItems.map((item) => (
                      <WatchlistRow
                        key={item.id}
                        item={item}
                        selected={selected?.id === item.id}
                        onSelect={() => {
                          setSelectedId(item.id)
                          setMobileDetailOpen(true)
                        }}
                        onRemove={() => void removeInstrument(item.id)}
                      />
                    ))}
                  </>
                )}
              </div>
            )}
          </div>
        </aside>

        <main
          className={cn(
            "min-h-0 min-w-0 flex-col overflow-y-auto md:flex",
            mobileDetailOpen ? "flex" : "hidden md:flex"
          )}
        >
          {selected ? (
            <>
              <section className="border-b border-border/60 px-4 py-3">
                <button
                  type="button"
                  onClick={() => setMobileDetailOpen(false)}
                  className="mb-3 flex items-center gap-1.5 rounded-md py-1 text-[13px] text-foreground/55 hover:text-foreground md:hidden"
                >
                  <ArrowLeft className="size-4" />
                  Watchlist
                </button>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    {selectedIsProduct && (
                      <ProductThumbnail
                        src={selected.imageUrl}
                        alt={selected.name}
                        size={72}
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-[22px] font-semibold tracking-tight">
                          {itemTitle(selected)}
                        </h2>
                        {!selectedIsProduct && (
                          <AssetBadge value={itemBadge(selected)} />
                        )}
                        {selected.exchange && (
                          <span className="text-[12px] text-foreground/45">
                            {selected.exchange}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 truncate text-[13px] text-foreground/50">
                        {itemSubtitle(selected)}
                      </p>
                      {selectedIsProduct && productPageUrl && (
                        <a
                          href={productPageUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1.5 inline-flex max-w-full items-center gap-1 text-[12px] text-foreground/55 hover:text-foreground"
                        >
                          <ExternalLink className="size-3.5 shrink-0" />
                          <span className="truncate">
                            {selected.exchange ?? "Product page"}
                          </span>
                        </a>
                      )}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[26px] font-semibold tracking-tight tabular-nums">
                      {formatPrice(q?.price, q?.currency ?? selected.currency)}
                    </div>
                    <div
                      className={cn(
                        "flex items-center justify-end gap-1 text-[13px] font-medium tabular-nums",
                        changeTone(q?.changePercent)
                      )}
                    >
                      {q?.change != null || q?.changePercent != null
                        ? `${formatSigned(q?.change)} · ${formatSigned(q?.changePercent, "%")}`
                        : selectedIsProduct
                          ? "First observation"
                          : "—"}
                    </div>
                  </div>
                </div>

                {selectedIsProduct ? (
                  <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <Stat
                      label="Previous"
                      value={formatPrice(
                        q?.previousClose,
                        q?.currency ?? selected.currency
                      )}
                    />
                    <Stat
                      label="Store"
                      value={selected.exchange ?? "—"}
                    />
                    <Stat
                      label="First tracked"
                      value={formatTime(selected.createdAt)}
                    />
                    <Stat
                      label="Last checked"
                      value={formatTime(selected.quoteUpdatedAt)}
                      tone={
                        selected.quoteStale
                          ? "text-amber-700 dark:text-amber-300"
                          : undefined
                      }
                    />
                  </div>
                ) : (
                  <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 2xl:grid-cols-6">
                    <Stat
                      label="Open"
                      value={formatPrice(
                        q?.open,
                        q?.currency ?? selected.currency
                      )}
                    />
                    <Stat
                      label="High"
                      value={formatPrice(
                        q?.high,
                        q?.currency ?? selected.currency
                      )}
                    />
                    <Stat
                      label="Low"
                      value={formatPrice(
                        q?.low,
                        q?.currency ?? selected.currency
                      )}
                    />
                    <Stat
                      label="Prev close"
                      value={formatPrice(
                        q?.previousClose,
                        q?.currency ?? selected.currency
                      )}
                    />
                    <Stat label="Volume" value={formatCompact(q?.volume)} />
                    <Stat
                      label={selected.quoteStale ? "Cached" : "Updated"}
                      value={formatTime(selected.quoteUpdatedAt)}
                      tone={
                        selected.quoteStale
                          ? "text-amber-700 dark:text-amber-300"
                          : undefined
                      }
                    />
                  </div>
                )}
              </section>

              {selectedIsProduct ? (
                <>
                  <HistoryPreview selected={selected} />
                  <div className="flex items-center gap-2 border-t border-border/60 px-4 py-2.5 text-[12px] text-foreground/45">
                    <Package className="size-3.5" />
                    <span>
                      Tracked locally · Price observations recorded on each
                      visit.
                    </span>
                  </div>
                </>
              ) : (
                <>
                  <section className="min-h-[420px] px-4 py-4">
                    <TradingViewChart
                      symbol={chartSymbol}
                      watchlist={tvWatchlist}
                      className="h-[min(58vh,620px)] min-h-[420px]"
                    />
                  </section>

                  <div className="flex flex-col items-start gap-2 border-t border-border/60 px-4 py-2.5 text-[12px] text-foreground/45 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <Bell className="size-3.5" />
                      Alerts are stored locally; scheduled monitoring plugs in
                      next.
                    </div>
                    <div className="flex min-w-0 items-center gap-1">
                      <Check className="size-3.5 text-emerald-600" />
                      Chart symbol {chartSymbol}
                    </div>
                  </div>

                  <HistoryPreview selected={selected} />
                </>
              )}
            </>
          ) : (
            <div className="flex min-h-[420px] flex-1 items-center justify-center px-6 text-center">
              <div>
                <div className="mx-auto flex size-12 items-center justify-center rounded-lg bg-muted">
                  <LineChart className="size-6 text-foreground/40" />
                </div>
                <h2 className="mt-4 text-[18px] font-semibold">
                  Build a watchlist
                </h2>
                <p className="mt-1 max-w-sm text-[13px] text-foreground/50">
                  Add an instrument from the search field or ask the model to
                  track it.
                </p>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
