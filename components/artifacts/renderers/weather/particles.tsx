"use client"

import * as React from "react"

import type { WeatherCondition } from "@/lib/weather/schema"

// ---------------------------------------------------------------------------
// Weather particle overlay — DOM-based for correct pixel sizing.
//
// Earlier attempt rendered particles inside an SVG with viewBox stretched
// to the hero card's aspect ratio (`preserveAspectRatio="none"`). That
// produced horizontally-elongated streaks instead of vertical raindrops
// because the hero card is much wider than it is tall — 1 viewBox unit
// stretches differently along each axis.
//
// This version uses absolute-positioned `<div>` elements with explicit
// pixel sizes. Each particle is sized in real pixels and animated with
// CSS keyframes that translate by a fixed pixel offset. The container
// hides overflow so partials clip cleanly at edges.
//
// Two parallax layers (background = smaller/slower, foreground = bigger/
// faster) give depth without overwhelming the foreground content. Thunder
// adds a periodic full-card flash.
//
// All positions are seeded deterministically by index so SSR + client
// hydration agree (no flicker).
// ---------------------------------------------------------------------------

interface ParticleProps {
    condition: WeatherCondition
    enabled?: boolean
}

const COUNTS: Partial<Record<WeatherCondition, { fg: number; bg: number }>> = {
    'drizzle':       { fg: 14, bg: 18 },
    'rain':          { fg: 22, bg: 26 },
    'heavy-rain':    { fg: 36, bg: 40 },
    'sleet':         { fg: 18, bg: 22 },
    'snow':          { fg: 16, bg: 22 },
    'heavy-snow':    { fg: 26, bg: 32 },
    'hail':          { fg: 16, bg: 20 },
    'thunderstorm':  { fg: 30, bg: 36 },
}

export function WeatherParticles({ condition, enabled = true }: ParticleProps) {
    const family = particleFamily(condition)
    if (!enabled || family === null) return null
    const counts = COUNTS[condition] ?? { fg: 18, bg: 22 }

    return (
        <div
            aria-hidden
            className="pointer-events-none absolute inset-0 z-0 overflow-hidden"
        >
            {family === 'thunder' && (
                // Full-card flash. Mix-blend-overlay keeps the gradient
                // underneath visible; the keyframe has 89% at 0 opacity so
                // flashes are rare and pronounced.
                <div className="pointer-events-none absolute inset-0 motion-safe:animate-[orchLightning_7s_ease-out_infinite] bg-white opacity-0 mix-blend-overlay" />
            )}
            <div className="absolute inset-0">
                {Array.from({ length: counts.bg }).map((_, i) => (
                    <Particle key={`b${i}`} seed={i} family={family} layer="bg" condition={condition} />
                ))}
            </div>
            <div className="absolute inset-0">
                {Array.from({ length: counts.fg }).map((_, i) => (
                    <Particle key={`f${i}`} seed={i + 100} family={family} layer="fg" condition={condition} />
                ))}
            </div>
            {condition === 'hail' && (
                <div className="absolute inset-0">
                    {Array.from({ length: 8 }).map((_, i) => (
                        <Particle key={`h${i}`} seed={i + 200} family="hail-pellet" layer="fg" condition={condition} />
                    ))}
                </div>
            )}
            <style>{KEYFRAMES_CSS}</style>
        </div>
    )
}

type Family = 'rain' | 'snow' | 'thunder' | 'hail-pellet'

function particleFamily(c: WeatherCondition): Family | null {
    switch (c) {
        case 'drizzle': case 'rain': case 'heavy-rain': case 'sleet': case 'hail':
            return 'rain'
        case 'thunderstorm':
            return 'thunder'
        case 'snow': case 'heavy-snow':
            return 'snow'
        default:
            return null
    }
}

function Particle({
    seed,
    family,
    layer,
    condition,
}: {
    seed: number
    family: Family
    layer: 'fg' | 'bg'
    condition: WeatherCondition
}) {
    const leftPct = hash01(seed, 1) * 100
    const delay = hash01(seed, 2) * 4
    const driftPx = (hash01(seed, 6) - 0.5) * 24

    if (family === 'rain' || family === 'thunder') {
        const heavy = condition === 'heavy-rain' || condition === 'thunderstorm'
        const light = condition === 'drizzle'
        const heightPx = light
            ? (layer === 'fg' ? 8 + hash01(seed, 3) * 4 : 5 + hash01(seed, 3) * 3)
            : heavy
                ? (layer === 'fg' ? 18 + hash01(seed, 3) * 6 : 12 + hash01(seed, 3) * 4)
                : (layer === 'fg' ? 14 + hash01(seed, 3) * 4 : 9 + hash01(seed, 3) * 3)
        const widthPx = layer === 'fg' ? (heavy ? 1.6 : 1.2) : 0.9
        const duration = (heavy ? 0.55 : light ? 1.1 : 0.75)
            + hash01(seed, 4) * 0.35
            + (layer === 'bg' ? 0.25 : 0)
        const opacity = layer === 'fg' ? (heavy ? 0.75 : 0.65) : 0.4
        return (
            <div
                style={{
                    position: 'absolute',
                    left: `${leftPct}%`,
                    top: 0,
                    width: `${widthPx}px`,
                    height: `${heightPx}px`,
                    background: `linear-gradient(to bottom, rgba(255,255,255,0) 0%, rgba(255,255,255,${opacity}) 40%, rgba(255,255,255,${opacity}) 100%)`,
                    borderRadius: `${widthPx}px`,
                    transform: 'translate3d(0, -20px, 0) rotate(8deg)',
                    transformOrigin: 'top',
                    animation: `orchRainFall ${duration.toFixed(2)}s linear ${delay.toFixed(2)}s infinite`,
                    willChange: 'transform, opacity',
                }}
            />
        )
    }

    if (family === 'snow') {
        const heavy = condition === 'heavy-snow'
        const sizePx = layer === 'fg'
            ? (heavy ? 4 + hash01(seed, 3) * 3 : 3 + hash01(seed, 3) * 2)
            : (heavy ? 2.5 + hash01(seed, 3) * 1.5 : 2 + hash01(seed, 3) * 1.2)
        const duration = (heavy ? 4.5 : 5.5) + hash01(seed, 4) * 2
        const opacity = layer === 'fg' ? 0.85 : 0.55
        return (
            <div
                style={{
                    position: 'absolute',
                    left: `${leftPct}%`,
                    top: 0,
                    width: `${sizePx}px`,
                    height: `${sizePx}px`,
                    borderRadius: '50%',
                    background: `radial-gradient(circle at 35% 35%, rgba(255,255,255,${opacity}) 0%, rgba(255,255,255,${opacity * 0.4}) 60%, rgba(255,255,255,0) 100%)`,
                    transform: 'translate3d(0, -20px, 0)',
                    animation: `orchSnowFall ${duration.toFixed(2)}s linear ${delay.toFixed(2)}s infinite`,
                    ['--orch-drift' as string]: `${driftPx.toFixed(1)}px`,
                    willChange: 'transform, opacity',
                } as React.CSSProperties}
            />
        )
    }

    if (family === 'hail-pellet') {
        const sizePx = 3 + hash01(seed, 3) * 2
        const duration = 0.5 + hash01(seed, 4) * 0.3
        return (
            <div
                style={{
                    position: 'absolute',
                    left: `${leftPct}%`,
                    top: 0,
                    width: `${sizePx}px`,
                    height: `${sizePx}px`,
                    background: 'white',
                    transform: 'translate3d(0, -20px, 0) rotate(45deg)',
                    boxShadow: '0 0 2px rgba(255,255,255,0.4)',
                    animation: `orchHailFall ${duration.toFixed(2)}s linear ${delay.toFixed(2)}s infinite`,
                    willChange: 'transform, opacity',
                }}
            />
        )
    }

    return null
}

function hash01(seed: number, salt: number): number {
    const v = Math.sin(seed * 12.9898 + salt * 78.233) * 43758.5453
    return v - Math.floor(v)
}

// Keyframes — translateY in pixels so motion is independent of card height.
// 200px is enough to clear any reasonable hero card; overflow:hidden on the
// parent clips correctly.
const KEYFRAMES_CSS = `
@keyframes orchRainFall {
    0%   { transform: translate3d(0, -20px, 0) rotate(8deg); opacity: 0; }
    8%   { opacity: 1; }
    92%  { opacity: 1; }
    100% { transform: translate3d(0, 220px, 0) rotate(8deg); opacity: 0; }
}
@keyframes orchHailFall {
    0%   { transform: translate3d(0, -20px, 0) rotate(45deg); opacity: 0; }
    10%  { opacity: 1; }
    100% { transform: translate3d(0, 220px, 0) rotate(45deg); opacity: 0; }
}
@keyframes orchSnowFall {
    0%   { transform: translate3d(0, -20px, 0); opacity: 0; }
    8%   { opacity: 1; }
    92%  { opacity: 0.9; }
    100% { transform: translate3d(var(--orch-drift, 0), 220px, 0); opacity: 0; }
}
@keyframes orchLightning {
    0%, 89%   { opacity: 0; }
    90%       { opacity: 0.85; }
    91%       { opacity: 0.15; }
    92%       { opacity: 0.7; }
    96%, 100% { opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
    @keyframes orchRainFall { from { opacity: 0.55; } to { opacity: 0.55; } }
    @keyframes orchHailFall { from { opacity: 0.6; } to { opacity: 0.6; } }
    @keyframes orchSnowFall { from { opacity: 0.7; } to { opacity: 0.7; } }
    @keyframes orchLightning { from { opacity: 0; } to { opacity: 0; } }
}
`
