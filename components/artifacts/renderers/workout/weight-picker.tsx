"use client"

import * as React from "react"
import { Check, Minus, Plus, X } from "lucide-react"

import { cn } from "@/lib/utils"
import { calculatePlates, formatPlatePlan, DEFAULT_PLATES, DEFAULT_BAR_WEIGHT } from "@/lib/workout/plate-calc"
import { estimated1RM } from "@/lib/workout/one-rep-max"
import { formatWeightNumber } from "@/lib/workout/format"

/**
 * Popover weight picker. Three input modes coexist:
 *   1. Quick-step pill row: `−10 −5 −2.5 +2.5 +5 +10` — covers 95% of
 *      mid-set adjustments ("can't make it, drop 5kg").
 *   2. Direct number input — for jumps to specific weight (deload, top set).
 *   3. Plate calculator preview — auto-updates as the value changes, showing
 *      bar setup ("20 bar + 25 + 15 per side").
 *
 * Plus a small "est. 1RM" hint when `reps` is provided, so the user can
 * see what a heavy single would estimate to.
 *
 * Apply/Cancel — Apply fires `onApply` with the new value; Cancel calls
 * `onClose` without mutating. Enter on the input also applies.
 */
export function WeightPicker({
    initialKg,
    barKg,
    plates,
    reps,
    onApply,
    onClose,
    className,
}: {
    initialKg: number
    /** Bar weight in kg. Default 20 (men's olympic). */
    barKg?: number
    /** Plates the user owns, descending. Default standard EU metric stack. */
    plates?: readonly number[]
    /** Optional rep count for the est. 1RM hint. */
    reps?: number
    onApply: (newKg: number) => void
    onClose: () => void
    className?: string
}) {
    const [value, setValue] = React.useState(initialKg)
    const inputRef = React.useRef<HTMLInputElement>(null)

    React.useEffect(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
    }, [])

    const effectiveBar = barKg ?? DEFAULT_BAR_WEIGHT
    const effectivePlates = plates ?? DEFAULT_PLATES

    const platePlan = React.useMemo(
        () => calculatePlates(value, { barKg: effectiveBar, availablePlatesKg: effectivePlates }),
        [value, effectiveBar, effectivePlates],
    )

    const est1RM = React.useMemo(
        () => (reps && reps > 0 ? estimated1RM(value, reps) : null),
        [value, reps],
    )
    const weightPresets = React.useMemo(
        () => buildWeightPresets(initialKg, effectiveBar, effectivePlates),
        [initialKg, effectiveBar, effectivePlates],
    )

    const step = (delta: number) => setValue((v) => Math.max(0, Math.round((v + delta) * 100) / 100))

    return (
        <div
            role="dialog"
            aria-label="Select weight"
            className={cn(
                "z-30 flex w-72 flex-col gap-3 rounded-xl border border-border/70 bg-popover p-3 shadow-xl",
                className,
            )}
            onKeyDown={(e) => {
                if (e.key === 'Escape') {
                    e.stopPropagation()
                    onClose()
                } else if (e.key === 'Enter') {
                    e.stopPropagation()
                    onApply(value)
                }
            }}
        >
            <div className="flex items-baseline gap-2">
                <input
                    ref={inputRef}
                    type="number"
                    step={0.5}
                    min={0}
                    value={value}
                    onChange={(e) => {
                        const n = parseFloat(e.target.value)
                        if (!Number.isNaN(n)) setValue(n)
                    }}
                    className={cn(
                        "w-24 rounded-md border border-border bg-background px-2 py-1.5 text-right text-lg font-semibold tabular-nums text-foreground",
                        "focus:outline-none focus:ring-2 focus:ring-ring",
                    )}
                />
                <span className="text-sm font-medium text-muted-foreground">kg</span>
                {est1RM !== null ? (
                    <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
                        est. 1RM <span className="font-semibold text-foreground">{est1RM}</span> kg
                    </span>
                ) : null}
            </div>

            <div className="grid grid-cols-3 gap-1">
                {weightPresets.map((preset) => (
                    <PresetBtn
                        key={preset}
                        active={Math.abs(value - preset) < 0.001}
                        onClick={() => setValue(preset)}
                    >
                        {formatWeightNumber(preset)}
                    </PresetBtn>
                ))}
            </div>

            <div className="grid grid-cols-6 gap-1">
                <StepBtn onClick={() => step(-10)} label="−10" />
                <StepBtn onClick={() => step(-5)} label="−5" />
                <StepBtn onClick={() => step(-2.5)} label="−2.5" />
                <StepBtn onClick={() => step(2.5)} label="+2.5" />
                <StepBtn onClick={() => step(5)} label="+5" />
                <StepBtn onClick={() => step(10)} label="+10" />
            </div>

            {platePlan ? (
                <div className="rounded-md bg-muted/55 px-2.5 py-1.5 text-[11.5px] leading-snug">
                    <div className="text-muted-foreground">
                        <span className="font-medium text-foreground">{formatWeightNumber(effectiveBar)} kg</span> bar
                        {platePlan.perSide.length > 0 ? (
                            <>
                                {' + '}
                                <span className="font-medium text-foreground">{formatPlatePlan(platePlan).replace(' per side', '')}</span>
                                {' per side'}
                            </>
                        ) : (
                            <span> only</span>
                        )}
                    </div>
                    {platePlan.remainderKg !== 0 ? (
                        <div className="mt-0.5 text-amber-600 dark:text-amber-400">
                            {platePlan.remainderKg > 0
                                ? `${platePlan.remainderKg} kg short — load ${formatWeightNumber(platePlan.actualKg)} kg or add smaller plates.`
                                : `${Math.abs(platePlan.remainderKg)} kg over.`}
                        </div>
                    ) : null}
                </div>
            ) : (
                <div className="rounded-md bg-rose-500/[0.08] px-2.5 py-1.5 text-[11.5px] text-rose-600 dark:text-rose-400">
                    Below bar weight ({effectiveBar} kg).
                </div>
            )}

            <div className="flex items-center justify-end gap-1.5">
                <button
                    type="button"
                    onClick={onClose}
                    className="flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1 text-[11.5px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                    <X className="size-3" />
                    Cancel
                </button>
                <button
                    type="button"
                    onClick={() => onApply(value)}
                    className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11.5px] font-semibold text-primary-foreground hover:opacity-90"
                >
                    <Check className="size-3" />
                    Save
                </button>
            </div>
        </div>
    )
}

function buildWeightPresets(initialKg: number, barKg: number, plates: readonly number[]): number[] {
    const smallestPlate = plates
        .filter((plate) => Number.isFinite(plate) && plate > 0)
        .reduce((min, plate) => Math.min(min, plate), Number.POSITIVE_INFINITY)
    const increment = Number.isFinite(smallestPlate)
        ? Math.max(0.5, Math.round(smallestPlate * 2 * 100) / 100)
        : 2.5
    const center = Math.max(0, Math.round(initialKg / increment) * increment)
    const presets = new Set<number>()
    for (let offset = -4; offset <= 4; offset++) {
        presets.add(Math.max(0, Math.round((center + offset * increment) * 100) / 100))
    }
    if (barKg > 0 && barKg <= center) presets.add(Math.round(barKg * 100) / 100)
    presets.add(Math.round(initialKg * 100) / 100)
    return Array.from(presets)
        .filter((preset) => Number.isFinite(preset) && preset >= 0)
        .sort((a, b) => a - b)
        .slice(0, 12)
}

function PresetBtn({
    active,
    onClick,
    children,
}: {
    active: boolean
    onClick: () => void
    children: React.ReactNode
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                "flex h-8 items-center justify-center rounded-md border px-1.5 text-[12px] font-semibold tabular-nums transition-colors",
                active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-border bg-background text-foreground/85 hover:bg-muted hover:text-foreground",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
        >
            {children}
        </button>
    )
}

function StepBtn({ label, onClick }: { label: string; onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                "flex h-8 items-center justify-center rounded-md border border-border bg-background text-[11.5px] font-medium tabular-nums text-foreground/85",
                "transition-colors hover:bg-muted hover:text-foreground",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
        >
            {label}
        </button>
    )
}

// Re-exports — let the set-row stop importing icons directly.
export { Minus, Plus }
