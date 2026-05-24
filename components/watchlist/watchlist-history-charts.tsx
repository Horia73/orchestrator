"use client"

import * as React from "react"
import { LineChart, Loader2 } from "lucide-react"
import { Area, AreaChart, CartesianGrid, Tooltip, XAxis, YAxis } from "recharts"

import { cn } from "@/lib/utils"
import type {
  WatchlistCandle,
  WatchlistDataStatus,
  WatchlistItemWithQuote,
  WatchlistRange,
} from "@/lib/watchlist/schema"
import {
  changeTone,
  formatPrice,
  formatSigned,
  responseError,
} from "./watchlist-view-helpers"

type HistoryResponse = {
  status: WatchlistDataStatus
  candles: WatchlistCandle[]
  updatedAt: number | null
  stale: boolean
  interval: string
  error?: string
}

type HistoryChartPoint = WatchlistCandle & {
  label: string
}

const RANGES: WatchlistRange[] = ["1D", "5D", "1M", "6M", "1Y"]

function formatAxisPrice(value: number | string) {
  const numeric = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(numeric)) return ""
  const abs = Math.abs(numeric)
  const digits = abs >= 100 ? 0 : abs >= 1 ? 2 : 4
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: digits,
  }).format(numeric)
}

function RangeSelector({
  range,
  onChange,
}: {
  range: WatchlistRange
  onChange: (range: WatchlistRange) => void
}) {
  return (
    <div className="inline-flex h-8 rounded-lg bg-muted/60 p-0.5">
      {RANGES.map((item) => (
        <button
          key={item}
          type="button"
          onClick={() => onChange(item)}
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
  )
}

function candlesToChartData(
  candles: WatchlistCandle[],
  range: WatchlistRange
): HistoryChartPoint[] {
  return candles.map((candle) => ({
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
}

function HistoryAreaChart({
  data,
  currency,
  height = 170,
  showYAxis = true,
}: {
  data: HistoryChartPoint[]
  currency?: string | null
  height?: number
  showYAxis?: boolean
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
    <div ref={containerRef} className="min-w-0" style={{ height }}>
      {width > 0 && (
        <AreaChart
          width={width}
          height={height}
          data={data}
          margin={{
            top: 6,
            right: 8,
            left: showYAxis ? 0 : -18,
            bottom: 0,
          }}
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
            hide={!showYAxis}
            width={showYAxis ? 42 : 0}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            tickFormatter={formatAxisPrice}
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

function ChartMetric({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: string
}) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] tracking-wide text-foreground/40 uppercase">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 truncate text-[15px] font-semibold text-foreground/85 tabular-nums",
          tone
        )}
      >
        {value}
      </div>
    </div>
  )
}

export function FinancialPriceChart({
  selected,
}: {
  selected: WatchlistItemWithQuote
}) {
  const [range, setRange] = React.useState<WatchlistRange>("1M")
  const [data, setData] = React.useState<HistoryResponse | null>(null)
  const [loading, setLoading] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    const loadHistory = async () => {
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
    void loadHistory()
    return () => {
      cancelled = true
    }
  }, [selected.id, range])

  const chartData = React.useMemo(
    () => candlesToChartData(data?.candles ?? [], range),
    [data?.candles, range]
  )

  const summary = React.useMemo(() => {
    if (chartData.length === 0) return null
    const first = chartData[0]
    const last = chartData[chartData.length - 1]
    const change = last.close - first.close
    const changePercent =
      first.close !== 0 ? (change / Math.abs(first.close)) * 100 : null
    const high = Math.max(...chartData.map((point) => point.high))
    const low = Math.min(...chartData.map((point) => point.low))
    return {
      last,
      change,
      changePercent,
      high,
      low,
    }
  }, [chartData])

  return (
    <section className="px-4 py-4">
      <div className="rounded-lg border border-border/60 bg-card p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <LineChart className="size-4 text-foreground/45" />
              <h2 className="text-[15px] font-semibold text-foreground/85">
                Price trend
              </h2>
              {loading && (
                <Loader2 className="size-3.5 animate-spin text-foreground/35" />
              )}
            </div>
            <p className="mt-1 truncate text-[12px] text-foreground/45">
              {selected.providerSymbol} · provider history
            </p>
          </div>
          <RangeSelector range={range} onChange={setRange} />
        </div>

        {data?.error && (
          <div className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:bg-amber-950/35 dark:text-amber-200">
            {data.error}
          </div>
        )}

        {summary && chartData.length > 1 ? (
          <>
            <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 border-y border-border/60 py-3 sm:grid-cols-4">
              <ChartMetric
                label="Last close"
                value={formatPrice(
                  summary.last.close,
                  selected.quote?.currency ?? selected.currency
                )}
              />
              <ChartMetric
                label={`${range} move`}
                value={formatSigned(summary.changePercent, "%")}
                tone={changeTone(summary.change)}
              />
              <ChartMetric
                label="High"
                value={formatPrice(
                  summary.high,
                  selected.quote?.currency ?? selected.currency
                )}
              />
              <ChartMetric
                label="Low"
                value={formatPrice(
                  summary.low,
                  selected.quote?.currency ?? selected.currency
                )}
              />
            </div>
            <div className="mt-4">
              <HistoryAreaChart
                data={chartData}
                currency={selected.quote?.currency ?? selected.currency}
                height={280}
              />
            </div>
          </>
        ) : (
          <div className="mt-4 flex h-[280px] items-center justify-center rounded-lg border border-dashed border-border/70 text-[13px] text-foreground/45">
            {loading ? "Loading history..." : "No cached history yet."}
          </div>
        )}
      </div>
    </section>
  )
}

export function HistoryPreview({
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
    return candlesToChartData(data?.candles ?? [], range)
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
        <RangeSelector range={range} onChange={setRange} />
      </div>

      {data?.error && (
        <div className="mb-2 rounded-md bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:bg-amber-950/35 dark:text-amber-200">
          {data.error}
        </div>
      )}

      {chartData.length > 1 ? (
        <HistoryAreaChart
          data={chartData}
          currency={selected?.currency}
          showYAxis={false}
        />
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
