"use client"

import * as React from "react"

import { LruCache } from "@/lib/cache/lru-cache"
import { isDesktopViewport } from "@/lib/desktop-viewport"

const MAX_HIGHLIGHT_CACHE_CHARACTERS = 2_000_000
const highlightCache = new LruCache<string, string>({
  maxEntries: 120,
  maxWeight: MAX_HIGHLIGHT_CACHE_CHARACTERS,
  weightOf: (html, key) => html.length + key.length,
})
const highlightInFlight = new Map<string, Promise<string>>()

interface ShikiHighlightOptions {
  deferOnMobile?: boolean
}

/** Shared, bounded and request-deduplicated Shiki highlighting. */
export function useShikiHighlight(
  code: string,
  language: string,
  options: ShikiHighlightOptions = {}
): string | null {
  const cacheKey = `${language}:${code}`
  const [html, setHtml] = React.useState<string | null>(
    () => highlightCache.get(cacheKey) ?? null
  )

  React.useEffect(() => {
    const cached = highlightCache.get(cacheKey)
    if (cached !== undefined) {
      setHtml(cached)
      return
    }

    setHtml(null)
    let cancelled = false
    let idleHandle: number | null = null

    const highlight = () => {
      void highlightCode(cacheKey, code, language).then((result) => {
        if (!cancelled) setHtml(result)
      })
    }

    const requestIdle = (
      window as typeof window & {
        requestIdleCallback?: (
          callback: () => void,
          options?: { timeout: number }
        ) => number
      }
    ).requestIdleCallback

    if (!options.deferOnMobile || isDesktopViewport()) {
      highlight()
    } else if (typeof requestIdle === "function") {
      idleHandle = requestIdle(highlight, { timeout: 1200 })
    } else {
      idleHandle = window.setTimeout(highlight, 1)
    }

    return () => {
      cancelled = true
      if (idleHandle == null) return
      const cancelIdle = (
        window as typeof window & {
          cancelIdleCallback?: (handle: number) => void
        }
      ).cancelIdleCallback
      if (typeof cancelIdle === "function") cancelIdle(idleHandle)
      else window.clearTimeout(idleHandle)
    }
  }, [cacheKey, code, language, options.deferOnMobile])

  return html
}

function highlightCode(
  cacheKey: string,
  code: string,
  language: string
): Promise<string> {
  const cached = highlightCache.get(cacheKey)
  if (cached !== undefined) return Promise.resolve(cached)

  const active = highlightInFlight.get(cacheKey)
  if (active) return active

  const request = import("shiki")
    .then(({ codeToHtml }) =>
      codeToHtml(code, { lang: language, theme: "github-light" })
    )
    .catch(() => "")
    .then((result) => {
      highlightCache.set(cacheKey, result)
      return result
    })
    .finally(() => {
      highlightInFlight.delete(cacheKey)
    })
  highlightInFlight.set(cacheKey, request)
  return request
}
