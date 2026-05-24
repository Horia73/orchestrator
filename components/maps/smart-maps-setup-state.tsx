"use client"

import { Loader2, MapPinned, RefreshCcw } from "lucide-react"

import { Button } from "@/components/ui/button"

export function SmartMapsSetupState({
  status,
  message,
  onRetry,
}: {
  status: "loading" | "error" | "unconfigured"
  message?: string
  onRetry?: () => void
}) {
  const isLoading = status === "loading"
  const isError = status === "error"

  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-hidden bg-background px-4 py-6">
      <div className="w-full max-w-xl rounded-lg border border-border/70 bg-background/95 p-5 shadow-sm">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-cyan-500/10 text-cyan-700 dark:text-cyan-300">
            {isLoading ? (
              <Loader2 className="size-5 animate-spin" />
            ) : (
              <MapPinned className="size-5" />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-[17px] font-semibold tracking-tight text-foreground">
              {isLoading
                ? "Loading Smart Maps"
                : isError
                  ? "Smart Maps config could not be checked"
                  : "Set up Smart Maps"}
            </h1>
            <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              {isLoading
                ? "Checking the local Maps integration before loading the map."
                : isError
                  ? (message ??
                    "The local Maps integration status endpoint did not return a usable response.")
                  : "Smart Maps needs GOOGLE_MAPS_API_KEY before the full-screen map can load. Add the key in Settings, then this page will open on your current location."}
            </p>

            {!isLoading && (
              <div className="mt-4 flex flex-wrap gap-2">
                <Button asChild size="sm">
                  <a href="/settings?tab=auth">Open Maps setup</a>
                </Button>
                {isError && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={onRetry}
                  >
                    <RefreshCcw className="size-3.5" />
                    Retry
                  </Button>
                )}
              </div>
            )}

            {!isLoading && !isError && (
              <div className="mt-4 grid gap-1.5 rounded-lg border border-border/60 bg-muted/25 px-3 py-2 text-[12px] text-muted-foreground">
                <div>Enable Maps JavaScript, Geocoding, Places, and Routes in Google Cloud.</div>
                <div>Add a JavaScript Vector Map ID for reliable tilt and rotation.</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
