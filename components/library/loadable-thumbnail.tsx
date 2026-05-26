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
    ...props
}: Omit<React.ImgHTMLAttributes<HTMLImageElement>, "src" | "alt"> & {
    src: string
    alt: string
    skeletonClassName?: string
}) {
    const imageRef = React.useRef<HTMLImageElement | null>(null)
    const [loaded, setLoaded] = React.useState(false)

    React.useEffect(() => {
        setLoaded(false)
    }, [src])

    React.useEffect(() => {
        if (imageRef.current?.complete) setLoaded(true)
    }, [src])

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
