"use client"

import * as React from "react"
import {
    Cloud,
    CloudDrizzle,
    CloudFog,
    CloudHail,
    CloudLightning,
    CloudMoon,
    CloudRain,
    CloudRainWind,
    CloudSnow,
    CloudSun,
    Cloudy,
    Moon,
    Snowflake,
    Sun,
    Wind,
} from "lucide-react"

import type { WeatherCondition } from "@/lib/weather/schema"
import { cn } from "@/lib/utils"

/**
 * Condition → lucide-react icon, with a day/night swap for clear /
 * partly-cloudy (Sun ↔ Moon, CloudSun ↔ CloudMoon). Everything else
 * is light-independent.
 *
 * Returns the component reference rather than rendering it — that way the
 * caller can size it (lucide icons take a `size` prop that we'd otherwise
 * have to thread through).
 */
function iconFor(condition: WeatherCondition, isDay: boolean): React.ComponentType<{ className?: string; strokeWidth?: number }> {
    switch (condition) {
        case 'clear':
            return isDay ? Sun : Moon
        case 'partly-cloudy':
            return isDay ? CloudSun : CloudMoon
        case 'cloudy':
            return Cloudy
        case 'overcast':
            return Cloud
        case 'fog':
            return CloudFog
        case 'drizzle':
            return CloudDrizzle
        case 'rain':
            return CloudRain
        case 'heavy-rain':
            return CloudRainWind
        case 'sleet':
        case 'snow':
            return CloudSnow
        case 'heavy-snow':
            return Snowflake
        case 'hail':
            return CloudHail
        case 'thunderstorm':
            return CloudLightning
        case 'windy':
            return Wind
        case 'unknown':
        default:
            return Cloud
    }
}

interface WeatherIconProps {
    condition: WeatherCondition
    isDay: boolean
    className?: string
    /** Visual weight — thicker stroke for the hero, thinner for inline rows. */
    strokeWidth?: number
    /** Optional title for screen readers. */
    'aria-label'?: string
}

/**
 * Lightweight wrapper around the condition→icon table. Defaults to a
 * 1.5-weight stroke (lucide's "outline" weight) which matches iOS Weather
 * better than the default 2.0. Caller controls sizing via Tailwind classes.
 */
export function WeatherIcon({
    condition,
    isDay,
    className,
    strokeWidth = 1.5,
    ...aria
}: WeatherIconProps) {
    const Icon = iconFor(condition, isDay)
    return (
        <Icon
            className={cn("shrink-0", className)}
            strokeWidth={strokeWidth}
            aria-label={aria['aria-label']}
        />
    )
}
