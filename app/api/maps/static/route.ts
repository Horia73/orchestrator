import { NextResponse } from "next/server"

import { guardSensitiveRequest } from "@/lib/api/request-guard"
import { getArtifactById } from "@/lib/artifacts/store"
import { readGoogleMapsApiKey } from "@/lib/maps/google-session"
import {
  readStaticMapCache,
  writeStaticMapCache,
} from "@/lib/maps/static-map-cache"
import { buildGoogleStaticMapUrl } from "@/lib/maps/static-map"
import { runWithRequestProfile } from "@/lib/profiles/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const NO_STORE = { "Cache-Control": "no-store" }

export async function GET(request: Request) {
  return runWithRequestProfile(request, async () => {
      const guard = guardSensitiveRequest(request)
      if (guard) return guard

      const url = new URL(request.url)
      const artifactId = url.searchParams.get("artifactId")?.trim()
      if (!artifactId) {
        return NextResponse.json(
          { error: "artifactId is required." },
          { status: 400, headers: NO_STORE }
        )
      }

      const artifact = getArtifactById(artifactId)
      if (!artifact || artifact.type !== "application/vnd.ant.map") {
        return NextResponse.json(
          { error: "Map artifact not found." },
          { status: 404, headers: NO_STORE }
        )
      }

      return staticMapResponse({
        source: artifact.content,
        width: parseInteger(url.searchParams.get("width")),
        height: parseInteger(url.searchParams.get("height")),
        scale: parseScale(url.searchParams.get("scale")),
        dayId: url.searchParams.get("dayId") ?? undefined,
        dayIndex: parseInteger(url.searchParams.get("dayIndex")),
        basemap: url.searchParams.get("basemap") ?? undefined,
      })
  })
}

export async function POST(request: Request) {
  return runWithRequestProfile(request, async () => {
      const guard = guardSensitiveRequest(request)
      if (guard) return guard

      const body = await request.json().catch(() => null)
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return NextResponse.json(
          { error: "Body must be a JSON object." },
          { status: 400, headers: NO_STORE }
        )
      }

      return staticMapResponse(body)
  })
}

async function staticMapResponse(input: unknown): Promise<Response> {
  const key = readGoogleMapsApiKey()
  if (!key) {
    return NextResponse.json(
      {
        error:
          "GOOGLE_MAPS_API_KEY is not set. Enable Static Maps API in the same Google Maps Platform project, then save the key.",
      },
      { status: 503, headers: NO_STORE }
    )
  }

  let built: ReturnType<typeof buildGoogleStaticMapUrl>
  try {
    built = buildGoogleStaticMapUrl(input, key)
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid static map request." },
      { status: 400, headers: NO_STORE }
    )
  }

  const primary = await loadStaticMapImage(built)
  if (primary.ok) {
    return imageResponse(primary.bytes, primary.contentType, built, primary.cacheStatus)
  }

  if (shouldRetryAsRoadmap(built, primary)) {
    try {
      const fallbackBuilt = buildGoogleStaticMapUrl(withRoadmapBasemap(input), key)
      const fallback = await loadStaticMapImage(fallbackBuilt)
      if (fallback.ok) {
        return imageResponse(
          fallback.bytes,
          fallback.contentType,
          fallbackBuilt,
          fallback.cacheStatus,
          ["Satellite/hybrid Static Maps unavailable for this account/region; rendered Google roadmap preview."]
        )
      }
    } catch {
      // Keep the primary Static Maps error below. The original failure tells
      // the user which Google API surface is blocked.
    }
  }

  return NextResponse.json(
    { error: primary.error },
    { status: primary.responseStatus, headers: NO_STORE }
  )
}

type StaticMapLoadResult =
  | {
      ok: true
      bytes: Buffer
      contentType: string
      cacheStatus: "HIT" | "MISS"
    }
  | {
      ok: false
      error: string
      responseStatus: number
      upstreamStatus?: number
      upstreamBody?: string
    }

async function loadStaticMapImage(
  built: ReturnType<typeof buildGoogleStaticMapUrl>
): Promise<StaticMapLoadResult> {
  const cached = readStaticMapCache(built.url)
  if (cached) {
    return {
      ok: true,
      bytes: cached.bytes,
      contentType: cached.contentType,
      cacheStatus: "HIT",
    }
  }

  let upstream: globalThis.Response
  try {
    upstream = await fetch(built.url, { cache: "no-store" })
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? `Static Maps request failed: ${error.message}`
          : "Static Maps request failed.",
      responseStatus: 502,
    }
  }

  if (!upstream.ok) {
    const body = await upstream.text().catch(() => "")
    return {
      ok: false,
      error: `Static Maps API returned HTTP ${upstream.status}.`,
      responseStatus: 502,
      upstreamStatus: upstream.status,
      upstreamBody: body.slice(0, 1000),
    }
  }

  const contentType = upstream.headers.get("content-type") || "image/png"
  const bytes = Buffer.from(await upstream.arrayBuffer())
  writeStaticMapCache(built.url, bytes, contentType)

  return {
    ok: true,
    bytes,
    contentType,
    cacheStatus: "MISS",
  }
}

function shouldRetryAsRoadmap(
  built: ReturnType<typeof buildGoogleStaticMapUrl>,
  result: StaticMapLoadResult
): boolean {
  if (result.ok) return false
  if (built.mapType !== "satellite" && built.mapType !== "hybrid") return false
  if (result.upstreamStatus !== 403) return false
  return /satellite and hybrid map types are not available/i.test(result.upstreamBody ?? "")
}

function withRoadmapBasemap(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return input
  }
  return {
    ...(input as Record<string, unknown>),
    basemap: "roadmap",
  }
}

function imageResponse(
  bytes: Buffer,
  contentType: string,
  built: ReturnType<typeof buildGoogleStaticMapUrl>,
  cacheStatus: "HIT" | "MISS",
  extraWarnings: string[] = []
): Response {
  const headers = new Headers(NO_STORE)
  headers.set("Content-Type", contentType)
  headers.set("X-Orch-Static-Map-Cache", cacheStatus)
  headers.set("X-Orch-Static-Map-Type", built.mapType)
  headers.set("X-Orch-Static-Map-Markers", String(built.markerCount))
  headers.set("X-Orch-Static-Map-Paths", String(built.pathCount))
  const warnings = [...built.warnings, ...extraWarnings]
  if (warnings.length > 0) {
    headers.set("X-Orch-Static-Map-Warnings", warnings.join(" | "))
  }

  return new Response(new Uint8Array(bytes), { status: 200, headers })
}

function parseInteger(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : undefined
}

function parseScale(value: string | null): 1 | 2 | undefined {
  return value === "1" || value === "2" ? Number(value) as 1 | 2 : undefined
}
