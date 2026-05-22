import type { WeatherCondition } from "@/lib/weather/schema"

/**
 * Weather condition + day/night → Tailwind gradient classes for the hero card.
 *
 * Mirrors the iOS Weather palette:
 *   - bright blues for clear day, deep indigo/violet for clear night
 *   - greys for cloudy/overcast (lighter for partly cloudy, darker for
 *     heavy-rain / thunderstorm)
 *   - cool slate for snow (almost white for fresh snow)
 *
 * The text-on-gradient is always white in the hero, so the gradient itself
 * has to be saturated enough to give >4.5:1 contrast against white. All
 * stops here are picked from the 400..900 range for that reason.
 */
export function heroGradient(condition: WeatherCondition, isDay: boolean): string {
    switch (condition) {
        case 'clear':
            return isDay
                ? 'from-sky-400 via-sky-500 to-blue-600'
                : 'from-indigo-950 via-slate-900 to-blue-950'
        case 'partly-cloudy':
            return isDay
                ? 'from-sky-400 via-slate-400 to-slate-500'
                : 'from-slate-800 via-indigo-900 to-slate-900'
        case 'cloudy':
            return isDay
                ? 'from-slate-400 via-slate-500 to-slate-600'
                : 'from-slate-700 via-slate-800 to-slate-900'
        case 'overcast':
            return 'from-slate-500 via-slate-600 to-slate-700'
        case 'fog':
            return 'from-stone-400 via-stone-500 to-stone-600'
        case 'drizzle':
            return 'from-slate-500 via-slate-600 to-slate-700'
        case 'rain':
            return isDay
                ? 'from-slate-500 via-slate-700 to-slate-800'
                : 'from-slate-700 via-slate-800 to-slate-900'
        case 'heavy-rain':
            return 'from-slate-700 via-slate-800 to-slate-950'
        case 'sleet':
            return 'from-slate-400 via-slate-500 to-slate-700'
        case 'snow':
            return 'from-slate-300 via-slate-400 to-slate-500'
        case 'heavy-snow':
            return 'from-slate-400 via-slate-500 to-slate-600'
        case 'hail':
            return 'from-slate-500 via-slate-600 to-slate-800'
        case 'thunderstorm':
            return 'from-slate-800 via-purple-900 to-slate-950'
        case 'windy':
            return isDay
                ? 'from-sky-500 via-slate-500 to-slate-600'
                : 'from-slate-700 via-slate-800 to-slate-900'
        case 'unknown':
        default:
            return isDay
                ? 'from-slate-400 via-slate-500 to-slate-600'
                : 'from-slate-700 via-slate-800 to-slate-900'
    }
}

/**
 * Background tint for outer sub-card containers (Hourly, Daily, Details).
 *
 * Picks up a subtle hint of the hero gradient so the artifact feels
 * cohesive without the cards going muddy. Earlier "full-saturation"
 * versions turned the cards into dark blocks on light chat backgrounds;
 * earlier "fully neutral" version killed all atmosphere. The sweet spot
 * is a very faint condition tint (~6-8% saturation) layered on a clean
 * near-white card.
 */
export function subCardTint(condition: WeatherCondition, isDay: boolean): string {
    if (!isDay) {
        // Night — cool blue-grey hint, still very subtle.
        return 'bg-slate-100/70 dark:bg-slate-800/35'
    }
    switch (condition) {
        case 'clear':
        case 'partly-cloudy':
        case 'windy':
            // Warm sky-tinted near-white.
            return 'bg-sky-50/70 dark:bg-slate-800/35'
        case 'thunderstorm':
        case 'heavy-rain':
        case 'hail':
            // Cooler grey when conditions are heavy.
            return 'bg-slate-100/80 dark:bg-slate-800/40'
        case 'snow':
        case 'heavy-snow':
        case 'sleet':
            // Crisp icy white tint.
            return 'bg-slate-50/80 dark:bg-slate-800/35'
        case 'fog':
            return 'bg-stone-100/70 dark:bg-stone-800/40'
        default:
            return 'bg-white/80 dark:bg-slate-800/35'
    }
}
