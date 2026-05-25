"use client"

import * as React from "react"
import { Search, X } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Compact search input for filtering Library tab content.
 *
 * Owns its own debounced state — callers receive `onDebouncedChange(q)`
 * 150ms after the user stops typing, never on every keystroke. Returns
 * the input ref so parent can imperatively `.focus()` (e.g. Cmd/Ctrl+F).
 *
 * Clears with the X button or Esc.
 */
export function LibrarySearchBar({
    placeholder,
    onDebouncedChange,
    className,
    initialValue = '',
}: {
    placeholder: string
    onDebouncedChange: (query: string) => void
    className?: string
    initialValue?: string
}) {
    const [value, setValue] = React.useState(initialValue)
    const inputRef = React.useRef<HTMLInputElement | null>(null)
    const lastEmitted = React.useRef<string>(initialValue)

    React.useEffect(() => {
        const t = window.setTimeout(() => {
            if (value !== lastEmitted.current) {
                lastEmitted.current = value
                onDebouncedChange(value)
            }
        }, 150)
        return () => window.clearTimeout(t)
    }, [value, onDebouncedChange])

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Escape' && value) {
            e.preventDefault()
            setValue('')
        }
    }

    const clear = () => {
        setValue('')
        inputRef.current?.focus()
    }

    return (
        <div
            className={cn(
                "relative flex items-center",
                className,
            )}
        >
            <Search className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground/65" aria-hidden />
            <input
                ref={inputRef}
                type="search"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={placeholder}
                aria-label={placeholder}
                className={cn(
                    "h-9 w-full rounded-md border border-border bg-background pl-8 pr-8 text-[13px] text-foreground placeholder:text-muted-foreground/65",
                    "focus:outline-none focus:ring-2 focus:ring-ring",
                )}
            />
            {value ? (
                <button
                    type="button"
                    onClick={clear}
                    aria-label="Clear search"
                    title="Clear (Esc)"
                    className="absolute right-2 flex size-5 items-center justify-center rounded text-muted-foreground/65 transition-colors hover:bg-muted hover:text-foreground"
                >
                    <X className="size-3" />
                </button>
            ) : null}
        </div>
    )
}

/**
 * Small case-insensitive substring filter helper. Returns true if `q` is
 * empty (no filter) or any of the `haystacks` contains the query.
 */
export function matchesQuery(q: string, ...haystacks: Array<string | null | undefined>): boolean {
    if (!q) return true
    const needle = q.trim().toLowerCase()
    if (!needle) return true
    return haystacks.some((h) => typeof h === 'string' && h.toLowerCase().includes(needle))
}
