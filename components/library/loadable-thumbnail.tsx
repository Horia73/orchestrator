"use client"

/* eslint-disable @next/next/no-img-element */

import * as React from "react"

import { cn } from "@/lib/utils"

export function LibraryImageLoadingOverlay({
    hidden,
    className,
}: {
    hidden?: boolean
    className?: string
}) {
    return (
        <span
            aria-hidden
            className={cn(
                "pointer-events-none absolute inset-0 overflow-hidden bg-muted/45 transition-opacity duration-300 ease-out",
                hidden ? "opacity-0" : "opacity-100",
                className,
            )}
        >
            <span className="library-media-shimmer absolute inset-y-0 -left-1/2 w-1/2 bg-gradient-to-r from-transparent via-background/70 to-transparent" />
        </span>
    )
}

export function LibraryLoadableImage({
    src,
    alt,
    className,
    skeletonClassName,
    onLoad,
    onError,
    onNaturalSize,
    ...props
}: Omit<React.ImgHTMLAttributes<HTMLImageElement>, "src" | "alt"> & {
    src: string
    alt: string
    skeletonClassName?: string
    /** Fires with the image's intrinsic dimensions once decoded — covers both
     *  the `onLoad` path and the cached/`complete`-on-mount path (where some
     *  browsers skip the load event). Lets callers lay out by aspect ratio. */
    onNaturalSize?: (width: number, height: number) => void
}) {
    const imageRef = React.useRef<HTMLImageElement | null>(null)
    const [loaded, setLoaded] = React.useState(false)

    const reportNaturalSize = React.useCallback(() => {
        const img = imageRef.current
        if (img && img.naturalWidth > 0 && img.naturalHeight > 0)
            onNaturalSize?.(img.naturalWidth, img.naturalHeight)
    }, [onNaturalSize])

    React.useEffect(() => {
        setLoaded(false)
    }, [src])

    React.useEffect(() => {
        if (imageRef.current?.complete) {
            setLoaded(true)
            reportNaturalSize()
        }
    }, [src, reportNaturalSize])

    return (
        <>
            <LibraryImageLoadingOverlay hidden={loaded} className={skeletonClassName} />
            <img
                {...props}
                ref={imageRef}
                src={src}
                alt={alt}
                onLoad={(event) => {
                    setLoaded(true)
                    reportNaturalSize()
                    onLoad?.(event)
                }}
                onError={(event) => {
                    setLoaded(true)
                    onError?.(event)
                }}
                className={cn(
                    "transition-[opacity,transform] duration-300 ease-out",
                    loaded ? "opacity-100" : "opacity-0",
                    className,
                )}
            />
        </>
    )
}
