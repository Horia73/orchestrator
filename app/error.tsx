"use client"

import * as React from "react"
import { AlertTriangle, RefreshCw } from "lucide-react"

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  React.useEffect(() => {
    console.error("[ui] route error", error)
  }, [error])

  return (
    <main className="flex h-dvh min-h-0 items-center justify-center bg-background px-5 text-foreground">
      <div className="w-full max-w-md rounded-2xl border border-border/70 bg-card p-6 text-center shadow-sm">
        <span className="mx-auto flex size-11 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <AlertTriangle className="size-5" />
        </span>
        <h1 className="mt-4 text-lg font-semibold">Something went wrong</h1>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          The current view could not be displayed. Your saved data is unchanged.
        </p>
        {error.digest ? (
          <p className="mt-2 font-mono text-[11px] text-muted-foreground/70">
            Error reference: {error.digest}
          </p>
        ) : null}
        <button
          type="button"
          onClick={reset}
          className="mx-auto mt-5 inline-flex h-9 items-center gap-2 rounded-lg bg-foreground px-4 text-sm font-medium text-background transition-opacity hover:opacity-85"
        >
          <RefreshCw className="size-4" />
          Try again
        </button>
      </div>
    </main>
  )
}
