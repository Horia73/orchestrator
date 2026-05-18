"use client"

import * as React from "react"
import { useTheme } from "next-themes"

import { cn } from "@/lib/utils"

interface TradingViewChartProps {
    symbol: string
    watchlist: string[]
    className?: string
}

export function TradingViewChart({ symbol, watchlist, className }: TradingViewChartProps) {
    const containerRef = React.useRef<HTMLDivElement>(null)
    const { resolvedTheme } = useTheme()
    const theme = resolvedTheme === "dark" ? "dark" : "light"

    React.useEffect(() => {
        const container = containerRef.current
        if (!container || !symbol) return

        container.innerHTML = ""
        const widget = document.createElement("div")
        widget.className = "tradingview-widget-container__widget h-full w-full"
        const script = document.createElement("script")
        script.type = "text/javascript"
        script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js"
        script.async = true
        script.innerHTML = JSON.stringify({
            autosize: true,
            symbol,
            interval: "D",
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC",
            theme,
            style: "1",
            locale: "en",
            allow_symbol_change: true,
            calendar: false,
            support_host: "https://www.tradingview.com",
            hide_side_toolbar: false,
            withdateranges: true,
            save_image: false,
            details: true,
            hotlist: false,
            watchlist,
            backgroundColor: theme === "dark" ? "rgba(32,32,32,1)" : "rgba(255,255,255,1)",
            gridColor: theme === "dark" ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)",
        })

        container.appendChild(widget)
        container.appendChild(script)

        return () => {
            container.innerHTML = ""
        }
    }, [symbol, theme, watchlist])

    return (
        <div className={cn("min-h-[360px] overflow-hidden rounded-lg border border-border bg-card", className)}>
            <div ref={containerRef} className="tradingview-widget-container h-full min-h-[360px] w-full" />
        </div>
    )
}
