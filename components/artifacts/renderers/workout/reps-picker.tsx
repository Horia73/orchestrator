"use client"

import * as React from "react"
import { Check, X } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Popover reps picker. Simpler than the weight picker — just ± buttons,
 * direct entry, and a row of quick-pick chips for the planned rep range.
 *
 * When `plannedRange` is `[6, 10]` (the schema sometimes carries ranges),
 * the chips become "6 7 8 9 10" for fast selection mid-set.
 */
export function RepsPicker({
    initialReps,
    plannedRange,
    onApply,
    onClose,
    className,
}: {
    initialReps: number
    /** Optional [low, high] target range — drives the quick-pick chip row. */
    plannedRange?: [number, number] | number
    onApply: (newReps: number) => void
    onClose: () => void
    className?: string
}) {
    const [value, setValue] = React.useState(initialReps)
    const inputRef = React.useRef<HTMLInputElement>(null)

    React.useEffect(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
    }, [])

    const step = (delta: number) => setValue((v) => Math.max(0, v + delta))

    const repPresets = React.useMemo(
        () => buildRepPresets(initialReps, plannedRange),
        [initialReps, plannedRange],
    )

    return (
        <div
            role="dialog"
            aria-label="Selectează reps"
            className={cn(
                "z-30 flex w-60 flex-col gap-3 rounded-xl border border-border/70 bg-popover p-3 shadow-xl",
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
                    step={1}
                    min={0}
                    value={value}
                    onChange={(e) => {
                        const n = parseInt(e.target.value, 10)
                        if (!Number.isNaN(n)) setValue(n)
                    }}
                    className={cn(
                        "w-20 rounded-md border border-border bg-background px-2 py-1.5 text-right text-lg font-semibold tabular-nums text-foreground",
                        "focus:outline-none focus:ring-2 focus:ring-ring",
                    )}
                />
                <span className="text-sm font-medium text-muted-foreground">reps</span>
            </div>

            <div className="grid grid-cols-4 gap-1">
                <StepBtn onClick={() => step(-5)} label="−5" />
                <StepBtn onClick={() => step(-1)} label="−1" />
                <StepBtn onClick={() => step(1)} label="+1" />
                <StepBtn onClick={() => step(5)} label="+5" />
            </div>

            <div className="grid grid-cols-4 gap-1">
                {repPresets.map((n) => (
                    <PresetBtn
                        key={n}
                        active={value === n}
                        onClick={() => setValue(n)}
                    >
                        {n}
                    </PresetBtn>
                ))}
            </div>

            <div className="flex items-center justify-end gap-1.5">
                <button
                    type="button"
                    onClick={onClose}
                    className="flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1 text-[11.5px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                    <X className="size-3" />
                    Anulează
                </button>
                <button
                    type="button"
                    onClick={() => onApply(value)}
                    className="flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 text-[11.5px] font-semibold text-primary-foreground hover:opacity-90"
                >
                    <Check className="size-3" />
                    Salvează
                </button>
            </div>
        </div>
    )
}

function buildRepPresets(initialReps: number, plannedRange?: [number, number] | number): number[] {
    const values = new Set<number>()
    const add = (value: number) => {
        if (Number.isFinite(value) && value >= 0 && value <= 100) values.add(Math.round(value))
    }

    add(initialReps)
    if (Array.isArray(plannedRange)) {
        const [lo, hi] = plannedRange
        if (hi - lo <= 10) {
            for (let n = lo; n <= hi; n++) add(n)
        } else {
            add(lo)
            add(Math.round((lo + hi) / 2))
            add(hi)
        }
        for (const n of [lo - 2, lo - 1, hi + 1, hi + 2]) add(n)
    } else {
        const center = plannedRange ?? initialReps
        for (let offset = -3; offset <= 3; offset++) add(center + offset)
    }

    for (const common of [1, 3, 5, 6, 8, 10, 12, 15, 20, 25, 30]) {
        const center = Array.isArray(plannedRange)
            ? (plannedRange[0] + plannedRange[1]) / 2
            : plannedRange ?? initialReps
        if (Math.abs(common - center) <= 8) add(common)
    }

    return Array.from(values).sort((a, b) => a - b).slice(0, 12)
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
