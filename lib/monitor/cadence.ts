import { MONITOR_CADENCE_STEP_SECONDS } from './schema'

export const MONITOR_CADENCE_STEP_MS = MONITOR_CADENCE_STEP_SECONDS * 1000

/** Return the current quarter-hour slot if already aligned, otherwise the
 *  next one. Smart Monitor checks should land on :00/:15/:30/:45 boundaries. */
export function alignToMonitorSlot(ms: number): number {
    const rounded = Math.floor(ms)
    const remainder = rounded % MONITOR_CADENCE_STEP_MS
    return remainder === 0
        ? rounded
        : rounded + (MONITOR_CADENCE_STEP_MS - remainder)
}

/** Strictly future quarter-hour slot after the provided time. */
export function nextMonitorSlotAfter(ms: number): number {
    return alignToMonitorSlot(ms + 1)
}

/** Next check time for a watch, snapped to the shared Smart Monitor slots. */
export function nextMonitorCheckAt(fromMs: number, cadenceSeconds: number): number {
    return alignToMonitorSlot(fromMs + cadenceSeconds * 1000)
}

export function isMonitorSlotAligned(ms: number): boolean {
    return Math.floor(ms) % MONITOR_CADENCE_STEP_MS === 0
}

/** Cadence adaptation is discrete: 15m, 30m, 45m, 60m, ... up to max. */
export function snapCadenceSeconds(seconds: number, min: number, max: number): number {
    const snapped = Math.round(seconds / MONITOR_CADENCE_STEP_SECONDS) * MONITOR_CADENCE_STEP_SECONDS
    return Math.min(max, Math.max(min, snapped))
}
