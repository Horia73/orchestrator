import { CronExpressionParser } from 'cron-parser'

import type { ScheduleSpec } from './schema'

// ---------------------------------------------------------------------------
// Schedule math. The only engine here is cron-parser (timezone/DST-correct);
// `dailyAt`/`weeklyAt` compile down to cron so there is exactly one code path
// for wall-clock scheduling. `once`/`every` are trivial arithmetic.
// ---------------------------------------------------------------------------

export class InvalidScheduleError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'InvalidScheduleError'
    }
}

function specToCron(spec: ScheduleSpec): { expression: string; timezone: string } | null {
    switch (spec.kind) {
        case 'dailyAt':
            return { expression: `${spec.minute} ${spec.hour} * * *`, timezone: spec.timezone }
        case 'weeklyAt':
            return {
                expression: `${spec.minute} ${spec.hour} * * ${[...spec.weekdays].sort((a, b) => a - b).join(',')}`,
                timezone: spec.timezone,
            }
        case 'cron':
            return { expression: spec.expression, timezone: spec.timezone }
        default:
            return null
    }
}

/**
 * Next fire time strictly after `fromMs`, or null when the schedule has no
 * future occurrence (a one-shot whose time has passed). Throws
 * InvalidScheduleError for malformed cron so create/update can reject it.
 */
export function computeNextRunAt(spec: ScheduleSpec, fromMs: number): number | null {
    if (spec.kind === 'once') {
        return spec.fireAt > fromMs ? spec.fireAt : null
    }

    if (spec.kind === 'every') {
        const anchor = spec.startAt ?? fromMs + spec.everyMs
        if (anchor > fromMs) return anchor
        const elapsed = fromMs - anchor
        const steps = Math.floor(elapsed / spec.everyMs) + 1
        return anchor + steps * spec.everyMs
    }

    const cron = specToCron(spec)
    if (!cron) throw new InvalidScheduleError(`Unsupported schedule kind: ${(spec as { kind: string }).kind}`)

    try {
        const it = CronExpressionParser.parse(cron.expression, {
            currentDate: new Date(fromMs),
            tz: cron.timezone,
        })
        return it.next().getTime()
    } catch (err) {
        throw new InvalidScheduleError(
            `Invalid cron "${cron.expression}" (${cron.timezone}): ${err instanceof Error ? err.message : 'parse error'}`,
        )
    }
}

/** Throws InvalidScheduleError if the spec can never be scheduled. */
export function assertSchedulable(spec: ScheduleSpec, nowMs: number): void {
    if (spec.kind === 'once' && spec.fireAt <= nowMs) {
        throw new InvalidScheduleError('One-shot fireAt is in the past.')
    }
    // For recurring kinds, computeNextRunAt throws on malformed cron.
    const next = computeNextRunAt(spec, nowMs)
    if (next == null && spec.kind !== 'once') {
        throw new InvalidScheduleError('Schedule has no future occurrence.')
    }
}

/** Human-readable one-liner for UI / Inbox / logs. */
export function describeSchedule(spec: ScheduleSpec): string {
    switch (spec.kind) {
        case 'once':
            return `once at ${new Date(spec.fireAt).toISOString()}`
        case 'every': {
            const m = Math.round(spec.everyMs / 60_000)
            if (m % 1440 === 0) return `every ${m / 1440}d`
            if (m % 60 === 0) return `every ${m / 60}h`
            return `every ${m}m`
        }
        case 'dailyAt':
            return `daily at ${pad(spec.hour)}:${pad(spec.minute)} ${spec.timezone}`
        case 'weeklyAt':
            return `weekly ${spec.weekdays.map(weekdayName).join(',')} at ${pad(spec.hour)}:${pad(spec.minute)} ${spec.timezone}`
        case 'cron':
            return `cron "${spec.expression}" ${spec.timezone}`
    }
}

function pad(n: number): string {
    return n.toString().padStart(2, '0')
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
function weekdayName(d: number): string {
    return WEEKDAY_NAMES[d] ?? String(d)
}
