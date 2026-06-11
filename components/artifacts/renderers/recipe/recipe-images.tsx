"use client"

import * as React from "react"
import { ExternalLink, ImageOff } from "lucide-react"

import { cn } from "@/lib/utils"
import type { RecipeImage } from "@/lib/recipe/schema"
import type { RecipeImageResult } from "@/lib/recipe/image-search"

/**
 * Image strip rendered above the recipe header.
 *
 * Source priority:
 *   1. If the model pre-populated `images[]` in the artifact body, use those
 *      directly (no fetch). The model can do this when it has an image search
 *      tool wired up — useful for highly specific dishes.
 *   2. Else if the model provided an `imageQuery`, fetch
 *      `/api/recipe-images?q=...` once on mount and render the results.
 *   3. Else render nothing (no image section at all — the recipe text reads
 *      fine without it).
 *
 * Loading state: 3 muted skeleton tiles matched to the final layout so the
 * card doesn't shift when images arrive. Failed fetches degrade silently —
 * we hide the strip rather than show a broken card inside a recipe.
 */
export function RecipeImages({
    images,
    imageQuery,
    className,
}: {
    images?: RecipeImage[]
    imageQuery?: string
    className?: string
}) {
    const [fetched, setFetched] = React.useState<RecipeImageResult[] | null>(null)
    const [loading, setLoading] = React.useState(false)
    const [failed, setFailed] = React.useState(false)
    // How many model-provided tiles have failed to load. Model `images[]` URLs
    // are frozen at generation time and unverified — there's no image-search
    // tool server-side, so the model hand-authors Wikimedia links that 404 (or
    // point at files later deleted). When EVERY model image is broken we fall
    // back to a live `imageQuery` fetch so the card heals itself instead of
    // showing a row of broken-image placeholders forever.
    const [modelErrorCount, setModelErrorCount] = React.useState(0)

    const modelImages = images ?? []
    const allModelImagesBroken =
        modelImages.length > 0 && modelErrorCount >= modelImages.length

    // Fetch when the model gave us no images, or when the ones it gave us have
    // all failed. Never refetch once we already hold a fetched result set.
    const shouldFetch =
        (!modelImages.length || allModelImagesBroken) && !!imageQuery && fetched === null

    React.useEffect(() => {
        if (!shouldFetch || !imageQuery) return
        const controller = new AbortController()
        setLoading(true)
        setFailed(false)
        fetch(`/api/recipe-images?q=${encodeURIComponent(imageQuery)}&limit=4`, {
            signal: controller.signal,
        })
            .then((r) => {
                if (!r.ok) throw new Error(`status ${r.status}`)
                return r.json() as Promise<{ images: RecipeImageResult[] }>
            })
            .then((data) => {
                setFetched(data.images ?? [])
            })
            .catch((err) => {
                if (err instanceof DOMException && err.name === "AbortError") return
                setFailed(true)
            })
            .finally(() => setLoading(false))
        return () => controller.abort()
    }, [imageQuery, shouldFetch])

    // Prefer live-fetched results once we have them — that covers both the
    // "model gave no images" path and the "model images all broke" self-heal.
    // Otherwise render the model's own images.
    const usingFetched = fetched !== null
    const display: NormalizedImage[] = React.useMemo(() => {
        if (fetched) return fetched.map(fetchedImageToNormalized)
        if (images?.length) return images.map(modelImageToNormalized)
        return []
    }, [fetched, images])

    if (loading) {
        return <RecipeImagesSkeleton className={className} />
    }
    if (failed || display.length === 0) {
        return null
    }

    return (
        <div
            className={cn(
                "flex gap-2 overflow-x-auto",
                "snap-x snap-mandatory scrollbar-hide",
                "-mx-2 px-2",
                className,
            )}
            role="list"
            aria-label="Imagini din rețetă"
        >
            {display.map((img, i) => (
                <ImageTile
                    key={`${img.url}-${i}`}
                    image={img}
                    // Only model images feed the self-heal counter; a failed
                    // live-fetched tile should just drop, not retrigger a fetch.
                    onError={usingFetched ? undefined : () => setModelErrorCount((n) => n + 1)}
                />
            ))}
        </div>
    )
}

interface NormalizedImage {
    url: string
    sourceUrl?: string
    attribution: string
    alt: string
    aspectRatio?: number
}

function modelImageToNormalized(img: RecipeImage): NormalizedImage {
    return {
        url: img.url,
        sourceUrl: img.sourceUrl,
        attribution: img.attribution,
        alt: img.alt ?? img.attribution,
    }
}

function fetchedImageToNormalized(img: RecipeImageResult): NormalizedImage {
    return {
        url: img.url,
        sourceUrl: img.sourceUrl,
        attribution: img.attribution,
        alt: img.attribution,
        aspectRatio: img.width && img.height ? img.width / img.height : undefined,
    }
}

const MAX_IMG_RETRIES = 2

function ImageTile({ image, onError }: { image: NormalizedImage; onError?: () => void }) {
    const [errored, setErrored] = React.useState(false)
    // Wikimedia throttles *uncached* thumbnails with a transient HTTP 429 while
    // its CDN generates the requested size on-demand, then serves 200 once the
    // thumb is warm. A recipe card requests several thumbnails at once, so the
    // first paint commonly eats a 429 or two. Retry the SAME url (no cache-bust
    // — we want the now-warm cache) a couple of times before giving up, so the
    // card fills in instead of showing broken-image placeholders.
    const [attempt, setAttempt] = React.useState(0)
    const retryTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
    React.useEffect(() => () => {
        if (retryTimer.current) clearTimeout(retryTimer.current)
    }, [])

    const handleImgError = () => {
        if (attempt >= MAX_IMG_RETRIES) {
            setErrored(true)
            onError?.()
            return
        }
        // Back off a touch so Wikimedia has time to finish generating the size.
        const delay = 600 * (attempt + 1)
        retryTimer.current = setTimeout(() => setAttempt((a) => a + 1), delay)
    }

    // Reserve a 4:3 box by default; if we got real dimensions from Wikimedia,
    // honour the actual aspect so 16:9 landscape shots don't crop awkwardly.
    const aspect = image.aspectRatio ? image.aspectRatio : 4 / 3
    const containerStyle = {
        aspectRatio: `${aspect}`,
        width: "260px",
        flex: "0 0 auto",
    } as const

    if (errored) {
        return (
            <div
                role="listitem"
                style={containerStyle}
                className="snap-center overflow-hidden rounded-lg border border-border bg-muted/40"
            >
                <div className="flex h-full flex-col items-center justify-center gap-1 px-2 text-center">
                    <ImageOff className="size-5 text-muted-foreground" aria-hidden />
                    <span className="text-[11px] text-muted-foreground">{image.attribution}</span>
                </div>
            </div>
        )
    }

    const inner = (
        <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
                // Remount on retry so the browser re-issues the request (it does
                // not cache the failed 429, so the same url is fetched fresh).
                key={attempt}
                src={image.url}
                alt={image.alt}
                loading="lazy"
                referrerPolicy="no-referrer"
                onError={handleImgError}
                className="h-full w-full object-cover"
            />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/65 via-black/30 to-transparent px-2 py-1.5">
                <span className="line-clamp-1 text-[11px] font-medium text-white/95 drop-shadow">
                    {image.attribution}
                </span>
            </div>
            {image.sourceUrl ? (
                <span className="pointer-events-none absolute right-1.5 top-1.5 inline-flex size-5 items-center justify-center rounded-full bg-black/45 text-white opacity-0 transition-opacity group-hover:opacity-100">
                    <ExternalLink className="size-3" aria-hidden />
                </span>
            ) : null}
        </>
    )

    const cardClass = cn(
        "group relative snap-center overflow-hidden rounded-lg border border-border bg-muted",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
    )

    if (image.sourceUrl) {
        return (
            <a
                role="listitem"
                href={image.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={containerStyle}
                className={cardClass}
                title={`${image.attribution} — deschide sursa`}
            >
                {inner}
            </a>
        )
    }
    return (
        <div role="listitem" style={containerStyle} className={cardClass}>
            {inner}
        </div>
    )
}

function RecipeImagesSkeleton({ className }: { className?: string }) {
    return (
        <div
            className={cn(
                "flex gap-2 overflow-hidden pb-1 -mx-2 px-2",
                className,
            )}
            aria-hidden
        >
            {[0, 1, 2].map((i) => (
                <div
                    key={i}
                    style={{ aspectRatio: "4 / 3", width: "260px" }}
                    className="flex-none animate-pulse rounded-lg border border-border bg-muted/60"
                />
            ))}
        </div>
    )
}
