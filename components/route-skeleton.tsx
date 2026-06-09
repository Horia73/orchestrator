import { Skeleton } from "@/components/ui/skeleton"

/**
 * Instant loading placeholder for top-level routes.
 *
 * Rendered by each route's `loading.tsx` so that navigating to a page shows
 * the page chrome + a shimmer immediately, instead of freezing on the previous
 * page until the new route's payload is ready (App Router blocks navigation
 * when a segment has no loading boundary). The header mirrors the real views'
 * top bar (border-b, mobile trigger slot, safe-area padding) so the swap to
 * real content doesn't jump.
 */
export function RouteSkeleton({
  variant = "list",
}: {
  variant?: "list" | "grid"
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-3 border-b border-border/60 px-4 pt-[calc(0.875rem+env(safe-area-inset-top))] pb-3 md:pt-4 dark:border-white/10">
        {/* mobile sidebar-trigger slot */}
        <Skeleton className="size-9 shrink-0 rounded-md md:hidden" />
        <Skeleton className="h-5 w-36 rounded" />
        <div className="ml-auto flex items-center gap-2">
          <Skeleton className="size-8 rounded-md" />
          <Skeleton className="hidden size-8 rounded-md sm:block" />
        </div>
      </header>

      {variant === "grid" ? (
        <div className="grid flex-1 auto-rows-min grid-cols-2 content-start gap-3 overflow-hidden p-4 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={`tile-${i}`} className="aspect-square w-full rounded-lg" />
          ))}
        </div>
      ) : (
        <div className="flex flex-1 flex-col overflow-hidden">
          {Array.from({ length: 9 }).map((_, i) => (
            <div
              key={`row-${i}`}
              className="flex items-start gap-3 border-b border-border/60 px-4 py-3.5 md:px-6 dark:border-white/10"
            >
              <Skeleton className="size-9 shrink-0 rounded-full" />
              <div className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
                <Skeleton className="h-3.5 w-1/3 rounded" />
                <Skeleton className="h-3 w-3/4 rounded" />
              </div>
              <Skeleton className="h-3 w-10 shrink-0 rounded" />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
