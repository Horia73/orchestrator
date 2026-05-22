"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

// ---------------------------------------------------------------------------
// Wind compass — Apple-style minimalist.
//
// Apple's wind tile uses a small compass on the right of the list. The
// compass has:
//   - Uniform fine tick marks around the perimeter (no colour bands)
//   - N / E / S / W glyphs outside the ring
//   - A simple line with a circular knob at the FROM-direction end
//   - Speed number large in the centre with the unit underneath
//
// We replicate that minimal look. No beaufort gimmicks. Stroke widths are
// thin and uniform.
// ---------------------------------------------------------------------------

interface WindCompassProps {
    direction: number
    speedLabel: string
    unitLabel: string
    cardinal: string
    className?: string
}

export function WindCompass({
    direction,
    speedLabel,
    unitLabel,
    cardinal,
    className,
}: WindCompassProps) {
    const rotation = direction % 360
    void cardinal

    return (
        <div className={cn("relative flex shrink-0 items-center justify-center", className)} style={{ width: 110, height: 110 }}>
            <svg viewBox="0 0 110 110" className="size-full" aria-hidden>
                {/* Outer tick marks — uniform, fine, every 5 degrees with
                    longer ticks at the cardinals. Drawn via a single
                    rendered loop. */}
                <g stroke="currentColor" strokeLinecap="round" opacity={0.32}>
                    {Array.from({ length: 72 }).map((_, i) => {
                        const angle = (i / 72) * 360
                        const isCardinal = i % 18 === 0
                        const len = isCardinal ? 6 : 3.5
                        const r0 = 48
                        const r1 = r0 - len
                        const a = (angle - 90) * (Math.PI / 180)
                        return (
                            <line
                                key={i}
                                x1={55 + Math.cos(a) * r0}
                                y1={55 + Math.sin(a) * r0}
                                x2={55 + Math.cos(a) * r1}
                                y2={55 + Math.sin(a) * r1}
                                strokeWidth={isCardinal ? 1.2 : 0.8}
                            />
                        )
                    })}
                </g>
                {/* Cardinal labels */}
                <g fontSize="9" fontFamily="ui-sans-serif, system-ui, sans-serif" fontWeight={500} fill="currentColor" opacity={0.62}>
                    <text x={55} y={9} textAnchor="middle" dominantBaseline="hanging">N</text>
                    <text x={101} y={56} textAnchor="end" dominantBaseline="middle">E</text>
                    <text x={55} y={104} textAnchor="middle" dominantBaseline="auto">S</text>
                    <text x={9} y={56} textAnchor="start" dominantBaseline="middle">W</text>
                </g>
                {/* Rotating direction indicator — single thin line with a
                    knob at the OUTER end (the side the wind comes FROM). */}
                <g style={{ transformOrigin: '55px 55px', transform: `rotate(${rotation}deg)`, transition: 'transform 800ms cubic-bezier(0.4,0,0.2,1)' }}>
                    <line x1={55} y1={20} x2={55} y2={42} stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" />
                    <circle cx={55} cy={18} r={3.2} fill="currentColor" />
                </g>
                {/* Centre: speed number + unit. */}
                <g textAnchor="middle" fontFamily="ui-sans-serif, system-ui, sans-serif">
                    <text x={55} y={59} fontSize="20" fontWeight={500} fill="currentColor" dominantBaseline="middle">
                        {speedLabel}
                    </text>
                    <text x={55} y={73} fontSize="8" fontWeight={500} fill="currentColor" opacity={0.55} dominantBaseline="middle">
                        {unitLabel}
                    </text>
                </g>
            </svg>
        </div>
    )
}
