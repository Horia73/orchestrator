"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

interface ConfirmOptions {
    title: string
    message?: string
    confirmLabel?: string
    cancelLabel?: string
    destructive?: boolean
}

export function ConfirmDialog({
    open,
    title,
    message,
    confirmLabel = "Confirm",
    cancelLabel = "Cancel",
    destructive,
    onConfirm,
    onCancel,
}: ConfirmOptions & { open: boolean; onConfirm: () => void; onCancel: () => void }) {
    React.useEffect(() => {
        if (!open) return
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCancel() }
        document.addEventListener("keydown", onKey)
        return () => document.removeEventListener("keydown", onKey)
    }, [open, onCancel])

    if (!open) return null
    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/40" onClick={onCancel} />
            <div className="relative w-full max-w-sm rounded-xl border border-border/60 bg-background p-5 shadow-xl">
                <div className="text-[15px] font-semibold">{title}</div>
                {message && <p className="mt-1.5 text-[13px] text-foreground/60">{message}</p>}
                <div className="mt-5 flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={onCancel}
                        className="rounded-md px-3 py-1.5 text-[13px] text-foreground/70 hover:bg-[#f0ede6] dark:hover:bg-muted"
                    >
                        {cancelLabel}
                    </button>
                    <button
                        type="button"
                        onClick={onConfirm}
                        className={cn(
                            "rounded-md px-3 py-1.5 text-[13px] text-background",
                            destructive ? "bg-[#802020] hover:opacity-90" : "bg-foreground hover:opacity-90",
                        )}
                    >
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </div>
    )
}

/**
 * Replaces window.confirm(). Usage:
 *   const { confirm, dialog } = useConfirm()
 *   ... if (await confirm({ title: "Delete?", destructive: true })) {...}
 *   return <>{dialog}{rest}</>
 */
export function useConfirm() {
    const [state, setState] = React.useState<
        (ConfirmOptions & { open: boolean }) | null
    >(null)
    const resolverRef = React.useRef<((v: boolean) => void) | null>(null)

    const confirm = React.useCallback((opts: ConfirmOptions) => {
        setState({ ...opts, open: true })
        return new Promise<boolean>(resolve => { resolverRef.current = resolve })
    }, [])

    const settle = React.useCallback((v: boolean) => {
        resolverRef.current?.(v)
        resolverRef.current = null
        setState(prev => (prev ? { ...prev, open: false } : prev))
    }, [])

    const dialog = state ? (
        <ConfirmDialog
            {...state}
            onConfirm={() => settle(true)}
            onCancel={() => settle(false)}
        />
    ) : null

    return { confirm, dialog }
}
