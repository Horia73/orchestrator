"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// Sun arc — Apple-style inline.
//
// Apple's Sunrise tile shows a tiny inline arc between the big sunrise time
// and the "Sunset: HH:MM" caption. The arc is just an outline of today's
// solar trajectory with the current position marked. No glow, no gradient,
// no "Solar arc" filler text — minimalist.
//
// We provide two exports:
//   - `SunArcInline` (default usage) — compact inline arc for the Sunrise
//     tile in the details grid.
//   - `SunArc` (legacy export retained for callers that imported it)
// ---------------------------------------------------------------------------

interface SunArcProps {
  sunrise: string
  sunset: string
  timezone: string
  className?: string
}

export function SunArcInline({
  sunrise,
  sunset,
  timezone,
  className,
}: SunArcProps) {
  const sunMs = toMs(sunrise)
  const setMs = toMs(sunset)
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const tick = () => setNow(Date.now())
    const id = setInterval(tick, 60_000)
    return () => clearInterval(id)
  }, [])
  const validWindow = sunMs && setMs && setMs > sunMs
  const frac = validWindow ? (now - sunMs) / (setMs - sunMs) : 0.5
  const visibleFrac = Math.max(0, Math.min(1, frac))
  const isVisible = frac >= 0 && frac <= 1

  // Compact arc geometry: 110×34 viewBox. Arc spans from (8, 30) over a
  // peak at (55, 4) to (102, 30). Sun marker sits on the parabola at the
  // current frac.
  const sunX = 8 + visibleFrac * 94
  const sunY = 30 - 26 * (1 - Math.pow(2 * visibleFrac - 1, 2))

  void timezone

  return (
    <div className={cn("w-full", className)}>
      <svg
        viewBox="0 0 110 34"
        preserveAspectRatio="none"
        className="block h-[34px] w-full"
        aria-hidden
      >
        {/* Horizon — fine dashed line */}
        <line
          x1={2}
          y1={30}
          x2={108}
          y2={30}
          stroke="currentColor"
          strokeOpacity={0.22}
          strokeWidth={0.5}
          strokeDasharray="1.5 2.5"
        />
        {/* Full arc — thin outline */}
        <path
          d="M 8 30 Q 55 -22 102 30"
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.28}
          strokeWidth={0.9}
          strokeLinecap="round"
        />
        {/* Sun / moon marker */}
        {isVisible ? (
          <>
            {/* Halo */}
            <circle
              cx={sunX}
              cy={sunY}
              r={5.5}
              fill="#fbbf24"
              fillOpacity={0.25}
            />
            {/* Core */}
            <circle
              cx={sunX}
              cy={sunY}
              r={2.6}
              fill="#fbbf24"
              stroke="white"
              strokeWidth={0.6}
            />
          </>
        ) : (
          <circle
            cx={frac < 0 ? 8 : 102}
            cy={30}
            r={2.4}
            fill="currentColor"
            opacity={0.55}
          />
        )}
      </svg>
    </div>
  )
}

// Legacy alias for any callers still importing `SunArc`.
export const SunArc = SunArcInline

function toMs(iso: string): number | null {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.getTime()
}
