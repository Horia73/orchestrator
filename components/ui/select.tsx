"use client"

import * as React from "react"
import { Check, ChevronDown } from "lucide-react"
import { cn } from "@/lib/utils"

export interface SelectOption {
    value: string
    label: string
}

/**
 * Custom select — replaces the native <select> so it matches the app's
 * surface (warm neutral, rounded, ring focus) on every platform/browser.
 * Closes on outside click / Escape; keyboard: Enter/Space toggles.
 */
export function Select({
    value,
    onValueChange,
    options,
    placeholder = "Select…",
    className,
    disabled,
}: {
    value: string
    onValueChange: (value: string) => void
    options: SelectOption[]
    placeholder?: string
    className?: string
    disabled?: boolean
}) {
    const [open, setOpen] = React.useState(false)
    const rootRef = React.useRef<HTMLDivElement>(null)
    const selected = options.find(o => o.value === value)

    React.useEffect(() => {
        if (!open) return
        const onDown = (e: MouseEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
        }
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false) }
        document.addEventListener("mousedown", onDown)
        document.addEventListener("keydown", onKey)
        return () => {
            document.removeEventListener("mousedown", onDown)
            document.removeEventListener("keydown", onKey)
        }
    }, [open])

    return (
        <div ref={rootRef} className={cn("relative", className)}>
            <button
                type="button"
                disabled={disabled}
                onClick={() => setOpen(o => !o)}
                className="flex h-9 w-full items-center justify-between gap-2 rounded-md border border-border/70 bg-background px-3 text-left text-[14px] outline-none focus:ring-2 focus:ring-foreground/15 disabled:opacity-50"
            >
                <span className={cn("truncate", !selected && "text-foreground/40")}>
                    {selected ? selected.label : placeholder}
                </span>
                <ChevronDown className={cn("size-4 shrink-0 text-foreground/40 transition-transform", open && "rotate-180")} />
            </button>
            {open && (
                <div className="absolute z-50 mt-1 max-h-64 w-full overflow-auto rounded-md border border-border/60 bg-background p-1 shadow-lg">
                    {options.map(opt => (
                        <button
                            key={opt.value}
                            type="button"
                            onClick={() => { onValueChange(opt.value); setOpen(false) }}
                            className={cn(
                                "flex w-full items-center justify-between gap-2 rounded-sm px-2.5 py-1.5 text-left text-[14px]",
                                opt.value === value ? "bg-[#f0ede6] text-foreground dark:bg-muted" : "text-foreground/75 hover:bg-[#f0ede6]/60 dark:hover:bg-muted/60",
                            )}
                        >
                            <span className="truncate">{opt.label}</span>
                            {opt.value === value && <Check className="size-3.5 shrink-0" />}
                        </button>
                    ))}
                </div>
            )}
        </div>
    )
}
