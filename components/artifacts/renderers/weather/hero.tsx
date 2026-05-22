"use client"

import * as React from "react"

import type { WeatherArtifact } from "@/lib/weather/schema"
import { cn } from "@/lib/utils"

import { heroGradient } from "./gradients"
import { WeatherParticles } from "./particles"

// ---------------------------------------------------------------------------
// Hero card — Apple-style minimalist.
//
// Apple Weather's hero is famously sparse:
//   - "MY LOCATION" small uppercase
//   - City name large
//   - "17° | Mostly Cloudy" inline subtitle
//
// No weather icon on the side — the gradient background (or photographic
// sky in iOS 15+) carries the visual. We keep the gradient and let
// particles add depth for wet/snowy conditions.
//
// The big H/L row is moved off the hero (Apple has it on a dedicated row
// below) but we keep it inline as a small line for compactness — it's
// what most users glance at first.
// ---------------------------------------------------------------------------

export function WeatherHero({
    artifact,
    todayHigh,
    todayLow,
}: {
    artifact: WeatherArtifact
    todayHigh: number
    todayLow: number
}) {
    const { current, location } = artifact
    const grad = heroGradient(current.condition, current.isDay)
    const tempUnit = artifact.units === 'metric' ? 'C' : 'F'

    return (
        <div
            className={cn(
                "relative isolate overflow-hidden rounded-2xl px-6 pt-6 pb-8 text-white shadow-md",
                "bg-gradient-to-br bg-[length:200%_200%] motion-safe:animate-[orchHeroGrad_28s_ease-in-out_infinite]",
                grad,
            )}
        >
            {/* Soft top halo — adds atmospheric depth. Decorative. */}
            <div
                aria-hidden
                className="pointer-events-none absolute -right-16 -top-16 z-0 size-72 rounded-full bg-white/10 blur-3xl"
            />

            {/* Animated rain / snow particles when conditions warrant. */}
            <WeatherParticles condition={current.condition} />

            {/* Apple-style compact header. No side icon (gradient is the
                visual). Column centred. Hero stays short so the detail
                cards below get the visual weight. */}
            <div className="relative z-10 flex flex-col items-center text-center">
                <div className="text-[10.5px] font-medium uppercase tracking-[0.15em] text-white/75">
                    My location
                </div>
                <h1 className="mt-1 max-w-full truncate text-[34px] font-medium leading-[1.1] tracking-tight" title={location.name}>
                    {location.name}
                </h1>
                <div className="mt-2 flex items-baseline gap-2 text-[17px] font-medium text-white/95">
                    <span className="tabular-nums">{Math.round(current.temperature)}°</span>
                    <span className="text-white/55">|</span>
                    <span className="capitalize">{current.conditionLabel}</span>
                </div>
                <div className="mt-1 text-[12px] tabular-nums text-white/65">
                    H: {Math.round(todayHigh)}°  L: {Math.round(todayLow)}°
                    <span className="ml-1.5 text-[10.5px] text-white/45">{tempUnit}</span>
                </div>
            </div>

            <style>{HERO_GRADIENT_KEYFRAMES}</style>
        </div>
    )
}

const HERO_GRADIENT_KEYFRAMES = `
@keyframes orchHeroGrad {
    0%   { background-position: 0% 50%; }
    50%  { background-position: 100% 50%; }
    100% { background-position: 0% 50%; }
}
`
