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

    // Skip the fetch entirely if the model gave us images directly.
    const shouldFetch = !images?.length && !!imageQuery

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

    // Normalize both shapes (model-provided / fetched) into a single
    // render-ready array so the JSX below doesn't branch per source.
    const display: NormalizedImage[] = React.useMemo(() => {
        if (images?.length) return images.map(modelImageToNormalized)
        if (fetched) return fetched.map(fetchedImageToNormalized)
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
                "flex gap-2 overflow-x-auto pb-1",
                "snap-x snap-mandatory scrollbar-thin",
                "-mx-2 px-2",
                className,
            )}
            role="list"
            aria-label="Imagini din rețetă"
        >
            {display.map((img, i) => (
                <ImageTile key={`${img.url}-${i}`} image={img} />
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

function ImageTile({ image }: { image: NormalizedImage }) {
    const [errored, setErrored] = React.useState(false)

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
                src={image.url}
                alt={image.alt}
                loading="lazy"
                referrerPolicy="no-referrer"
                onError={() => setErrored(true)}
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
