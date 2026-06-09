"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Minimal dependency-free line sparkline. Plots `values` left→right (oldest
 * first), normalizing to the series' own min/max so flat-ish trends still read.
 * Returns null for fewer than two finite points. Keeps the bundle lean — no
 * chart library — and inherits color from `currentColor`.
 */
export function Sparkline({
    values,
    width = 120,
    height = 32,
    strokeClass = "text-primary",
    className,
    ariaLabel,
}: {
    values: number[]
    width?: number
    height?: number
    strokeClass?: string
    className?: string
    ariaLabel?: string
}) {
    const points = React.useMemo(
        () => values.filter((v) => Number.isFinite(v)),
        [values],
    )
    if (points.length < 2) return null

    const padX = 2
    const padY = 4
    const minY = Math.min(...points)
    const maxY = Math.max(...points)
    const yRange = Math.max(1e-6, maxY - minY)
    const xMax = points.length - 1

    const coords = points.map((y, i) => {
        const px = padX + (i / xMax) * (width - padX * 2)
        const py = padY + (1 - (y - minY) / yRange) * (height - padY * 2)
        return [px, py] as const
    })
    const path = coords
        .map(([x, y], i) => `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`)
        .join(" ")
    const [lastX, lastY] = coords[coords.length - 1]

    return (
        <svg
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            className={cn(strokeClass, className)}
            role="img"
            aria-label={ariaLabel}
        >
            <path
                d={path}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.75}
                strokeLinejoin="round"
                strokeLinecap="round"
            />
            <circle cx={lastX} cy={lastY} r={2.25} fill="currentColor" />
        </svg>
    )
}
