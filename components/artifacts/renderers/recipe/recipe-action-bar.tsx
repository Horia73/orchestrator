"use client"

import * as React from "react"
import { Check, Copy, Minus, Plus, Printer } from "lucide-react"

import { cn } from "@/lib/utils"
import { copyTextToClipboard } from "@/lib/clipboard"
import { recipeToMarkdown } from "@/lib/recipe/to-markdown"
import type { RecipeArtifact, RecipeServings } from "@/lib/recipe/schema"

/**
 * Servings stepper. Lives above the ingredient list and drives the scaling
 * ratio for the whole card. Stateless — owner (RecipeRenderer) holds the
 * current value so it can derive the ratio for ingredient display.
 *
 * Bounds:
 *   - lower: `servings.min ?? 1`
 *   - upper: `servings.max ?? max(20, default * 4)` — the schema doesn't
 *     require an upper bound, so we cap pragmatically so the +/- buttons
 *     don't let a user accidentally compute "8000 g flour" for a one-serving
 *     starter recipe.
 *
 * Keyboard: each button is independently focusable + activates on Space/Enter
 * (native). Arrow keys on either button also step (so an arrowy user can
 * adjust without re-targeting).
 *
 * a11y: the displayed value uses `aria-live="polite"` so screen readers
 * announce the new count after each step.
 */
export function RecipeActionBar({
    servings,
    value,
    onChange,
    recipe,
    className,
}: {
    servings: RecipeServings
    value: number
    /**
     * Accepts the React.Dispatch SetStateAction shape so the stepper can
     * use functional updates (`prev => prev + 1`). Necessary because
     * holding down a key, autorepeat, or rapid clicks all trigger several
     * dispatches inside one render frame — a plain `onChange(value + 1)`
     * would all see the same stale `value` and only advance once.
     */
    onChange: React.Dispatch<React.SetStateAction<number>>
    /**
     * Full recipe — passed in so Copy/Print can render the current state
     * (scaled to the live `value` of the stepper). Print is a global window
     * call so a single page may host many recipes; the stylesheet is scoped
     * to `.recipe-print-root` set on the active article via a CSS class
     * toggle right before print.
     */
    recipe: RecipeArtifact
    className?: string
}) {
    const min = servings.min ?? 1
    const max = servings.max ?? Math.max(20, servings.default * 4)

    const clamp = React.useCallback(
        (n: number) => Math.min(max, Math.max(min, Math.round(n))),
        [max, min],
    )

    const stepBy = React.useCallback(
        (delta: number) => {
            onChange((prev) => clamp(prev + delta))
        },
        [clamp, onChange],
    )

    const setExact = React.useCallback(
        (next: number) => {
            if (!Number.isFinite(next)) return
            onChange(clamp(next))
        },
        [clamp, onChange],
    )

    const handleKey = React.useCallback(
        (e: React.KeyboardEvent<HTMLDivElement>) => {
            if (e.key === "ArrowUp" || e.key === "ArrowRight" || e.key === "+") {
                e.preventDefault()
                stepBy(1)
            } else if (e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "-") {
                e.preventDefault()
                stepBy(-1)
            } else if (e.key === "Home") {
                e.preventDefault()
                setExact(min)
            } else if (e.key === "End") {
                e.preventDefault()
                setExact(max)
            }
        },
        [max, min, setExact, stepBy],
    )

    const label = servings.unitLabel ?? "porții"
    const atMin = value <= min
    const atMax = value >= max

    const [copied, setCopied] = React.useState(false)
    const copyResetRef = React.useRef<number | null>(null)

    const handleCopy = React.useCallback(async () => {
        const md = recipeToMarkdown(recipe, { servings: value })
        const ok = await copyTextToClipboard(md)
        if (!ok) return
        setCopied(true)
        if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current)
        copyResetRef.current = window.setTimeout(() => setCopied(false), 1500)
    }, [recipe, value])

    React.useEffect(() => () => {
        if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current)
    }, [])

    const handlePrint = React.useCallback((e: React.MouseEvent<HTMLElement>) => {
        // Walk up from the clicked button to the recipe <article>. The global
        // print stylesheet hides everything outside `.recipe-print-active` so
        // only this card prints — multiple recipes on one page each get a
        // clean printout when their respective Print button is clicked.
        const article = e.currentTarget.closest("article[data-recipe]") as HTMLElement | null
        if (!article) {
            // Defensive: if the DOM moved, fall back to a global print.
            window.print()
            return
        }

        // Clean any stale promotions from interrupted previous prints.
        document.querySelectorAll(".recipe-print-active").forEach((el) => {
            el.classList.remove("recipe-print-active")
        })
        article.classList.add("recipe-print-active")

        const onAfter = () => {
            article.classList.remove("recipe-print-active")
            window.removeEventListener("afterprint", onAfter)
        }
        window.addEventListener("afterprint", onAfter)
        try {
            window.print()
        } catch {
            window.removeEventListener("afterprint", onAfter)
            article.classList.remove("recipe-print-active")
        }
    }, [])

    return (
        <div
            className={cn(
                "flex flex-wrap items-center gap-3 text-sm",
                className,
            )}
            onKeyDown={handleKey}
        >
            <span className="font-medium text-foreground">{capitalize(label)}</span>
            <div
                role="group"
                aria-label={`Selector ${label}`}
                className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-1 py-0.5"
            >
                <StepperButton
                    label={`Scade ${label}`}
                    disabled={atMin}
                    onClick={() => stepBy(-1)}
                >
                    <Minus className="size-3.5" aria-hidden />
                </StepperButton>
                <span
                    aria-live="polite"
                    aria-atomic="true"
                    className="min-w-[2ch] px-1.5 text-center font-medium tabular-nums text-foreground"
                >
                    {value}
                </span>
                <StepperButton
                    label={`Crește ${label}`}
                    disabled={atMax}
                    onClick={() => stepBy(1)}
                >
                    <Plus className="size-3.5" aria-hidden />
                </StepperButton>
            </div>

            <div className="recipe-print-hide ml-auto inline-flex items-center gap-1">
                <UtilityButton label="Copiază ca markdown" onClick={() => void handleCopy()}>
                    {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
                </UtilityButton>
                <UtilityButton label="Printează rețeta" onClick={handlePrint}>
                    <Printer className="size-3.5" aria-hidden />
                </UtilityButton>
            </div>
        </div>
    )
}

function UtilityButton({
    label,
    onClick,
    children,
}: {
    label: string
    onClick: (e: React.MouseEvent<HTMLButtonElement>) => void
    children: React.ReactNode
}) {
    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            onClick={onClick}
            className={cn(
                "inline-flex size-7 items-center justify-center rounded-full border border-border bg-background",
                "text-muted-foreground transition-colors",
                "hover:bg-muted hover:text-foreground",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
            )}
        >
            {children}
        </button>
    )
}

function StepperButton({
    label,
    disabled,
    onClick,
    children,
}: {
    label: string
    disabled?: boolean
    onClick: () => void
    children: React.ReactNode
}) {
    return (
        <button
            type="button"
            aria-label={label}
            disabled={disabled}
            onClick={onClick}
            className={cn(
                "inline-flex size-6 items-center justify-center rounded-full",
                "text-muted-foreground transition-colors",
                "hover:bg-muted hover:text-foreground",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground",
            )}
        >
            {children}
        </button>
    )
}

function capitalize(s: string): string {
    return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1)
}
