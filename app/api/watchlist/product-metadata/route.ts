import { NextResponse } from "next/server"

import { fetchProductMetadata } from "@/lib/watchlist/product-metadata"
import { runWithRequestProfile } from "@/lib/profiles/server"

const NO_STORE = { "Cache-Control": "no-store" }

export async function GET(request: Request) {
  return runWithRequestProfile(request, async () => {
      try {
        const url = new URL(request.url)
        const target = (url.searchParams.get("url") ?? "").trim()
        if (!target) {
          return NextResponse.json(
            { error: "Missing required parameter: url" },
            { status: 400, headers: NO_STORE }
          )
        }
        const result = await fetchProductMetadata(target)
        if (!result.ok) {
          return NextResponse.json(
            { error: result.error },
            { status: 422, headers: NO_STORE }
          )
        }
        return NextResponse.json({ metadata: result.data }, { headers: NO_STORE })
      } catch (error) {
        console.error("Failed to fetch product metadata", error)
        return NextResponse.json(
          { error: "Failed to fetch product metadata" },
          { status: 500, headers: NO_STORE }
        )
      }
  })
}
