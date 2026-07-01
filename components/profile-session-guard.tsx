"use client"

import * as React from "react"

/**
 * Recovers from the half-authenticated state: the profile session cookie still
 * exists (so the middleware gate lets page loads through) but the server-side
 * session record is gone — every /api/* call answers 401 profile_required and
 * the UI silently degrades (empty lists, "couldn't be previewed" files).
 * Nothing else on the client watches for that code, so patch fetch once and
 * bounce to the profile picker the first time it shows up.
 */

let installed = false
let redirecting = false

function isGuardedPath(input: RequestInfo | URL): boolean {
    try {
        const raw =
            typeof input === "string"
                ? input
                : input instanceof URL
                  ? input.href
                  : input.url
        const url = new URL(raw, window.location.origin)
        if (url.origin !== window.location.origin) return false
        return url.pathname.startsWith("/api/") || url.pathname.startsWith("/files/")
    } catch {
        return false
    }
}

function redirectToProfiles() {
    if (redirecting) return
    if (window.location.pathname.startsWith("/profiles")) return
    redirecting = true
    const next = `${window.location.pathname}${window.location.search}`
    window.location.assign(`/profiles?next=${encodeURIComponent(next)}`)
}

export function ProfileSessionGuard() {
    React.useEffect(() => {
        if (installed) return
        installed = true
        const originalFetch = window.fetch.bind(window)
        window.fetch = async (...args: Parameters<typeof fetch>) => {
            const response = await originalFetch(...args)
            if (response.status === 401 && isGuardedPath(args[0])) {
                try {
                    const body = (await response.clone().json()) as { code?: string }
                    if (body?.code === "profile_required") redirectToProfiles()
                } catch {
                    /* non-JSON 401 — not the profile gate */
                }
            }
            return response
        }
    }, [])

    return null
}
