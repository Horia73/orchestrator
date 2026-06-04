"use client"

import * as React from "react"
import { MessageSquare, Pencil, SkipForward, XCircle } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Dropdown menu attached to a set's MoreVertical button. Phase 2 actions:
 *   - Skip          → undoSet + mark logged.completed=false (visually: ○)
 *   - Mark as failed → logSet with failed=true + optional partialReps
 *   - Add note      → opens a custom inline-notes dialog
 *
 * Drop set after / convert to AMRAP are Phase 3 candidates that require
 * mutating the artifact's planned[] which we don't do yet.
 *
 * Auto-closes on outside click and Escape.
 */
export function SetActionsMenu({
    open,
    onClose,
    onEdit,
    onSkip,
    onMarkFailed,
    onAddNote,
    canEdit,
    canSkip,
    canMarkFailed,
    className,
}: {
    open: boolean
    onClose: () => void
    onEdit?: () => void
    onSkip: () => void
    onMarkFailed: () => void
    onAddNote: () => void
    canEdit?: boolean
    canSkip: boolean
    canMarkFailed: boolean
    className?: string
}) {
    const ref = React.useRef<HTMLDivElement>(null)

    React.useEffect(() => {
        if (!open) return
        function handleClick(e: MouseEvent) {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                onClose()
            }
        }
        function handleKey(e: KeyboardEvent) {
            if (e.key === 'Escape') onClose()
        }
        document.addEventListener('mousedown', handleClick)
        document.addEventListener('keydown', handleKey)
        return () => {
            document.removeEventListener('mousedown', handleClick)
            document.removeEventListener('keydown', handleKey)
        }
    }, [open, onClose])

    if (!open) return null

    return (
        <div
            ref={ref}
            role="menu"
            className={cn(
                "absolute right-0 top-full z-20 mt-1 w-48 overflow-hidden rounded-lg border border-border/70 bg-popover py-1 shadow-lg",
                "animate-in fade-in slide-in-from-top-1 fill-mode-both duration-150",
                className,
            )}
        >
            {onEdit ? (
                <MenuItem
                    onClick={() => { onEdit(); onClose() }}
                    disabled={!canEdit}
                    icon={<Pencil className="size-3.5" strokeWidth={1.85} />}
                    label="Editează setul"
                    hint="Actuale, RPE, RIR, notă"
                />
            ) : null}
            <MenuItem
                onClick={() => { onMarkFailed(); onClose() }}
                disabled={!canMarkFailed}
                icon={<XCircle className="size-3.5" strokeWidth={1.85} />}
                label="Marchează failed"
                hint="Setul s-a oprit înainte de target"
            />
            <MenuItem
                onClick={() => { onSkip(); onClose() }}
                disabled={!canSkip}
                icon={<SkipForward className="size-3.5" strokeWidth={1.85} />}
                label="Sari peste set"
            />
            <MenuItem
                onClick={() => { onAddNote(); onClose() }}
                icon={<MessageSquare className="size-3.5" strokeWidth={1.85} />}
                label="Adaugă notă"
            />
        </div>
    )
}

function MenuItem({
    onClick,
    disabled,
    icon,
    label,
    hint,
}: {
    onClick: () => void
    disabled?: boolean
    icon: React.ReactNode
    label: string
    hint?: string
}) {
    return (
        <button
            type="button"
            role="menuitem"
            onClick={onClick}
            disabled={disabled}
            className={cn(
                "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] transition-colors",
                "hover:bg-muted",
                "focus-visible:outline-none focus-visible:bg-muted",
                "disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent",
            )}
        >
            <span className="shrink-0 text-muted-foreground">{icon}</span>
            <span className="min-w-0 flex-1">
                <div className="font-medium text-foreground">{label}</div>
                {hint ? <div className="text-[10.5px] text-muted-foreground">{hint}</div> : null}
            </span>
        </button>
    )
}
