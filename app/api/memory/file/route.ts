import fs from "fs"
import path from "path"
import { NextResponse } from "next/server"

import { guardSensitiveRequest } from "@/lib/api/request-guard"
import { findLibraryAsset } from "@/lib/memory/library"

const ALLOWED_PREVIEW_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "application/pdf",
])

export async function GET(request: Request) {
  const guard = guardSensitiveRequest(request)
  if (guard) return guard

  try {
    const url = new URL(request.url)
    const assetKey = url.searchParams.get("assetKey")?.trim() ?? ""
    if (!assetKey) {
      return NextResponse.json({ error: "Missing `assetKey`." }, { status: 400 })
    }

    const asset = findLibraryAsset(assetKey)
    const mimeType = asset?.mimeType.split(";")[0]?.trim() ?? ""
    if (!asset || !ALLOWED_PREVIEW_MIMES.has(mimeType)) {
      return NextResponse.json({ error: "File not found." }, { status: 404 })
    }

    const stat = fs.statSync(asset.path)
    if (!stat.isFile() || stat.size <= 0) {
      return NextResponse.json({ error: "File not found." }, { status: 404 })
    }

    const bytes = fs.readFileSync(asset.path)
    const filename = path.basename(asset.displayPath || asset.path).replace(/"/g, "")
    return new Response(bytes, {
      headers: {
        "Content-Type": mimeType,
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "private, no-store",
      },
    })
  } catch (error) {
    console.error("Memory file preview failed", error)
    return NextResponse.json({ error: "Preview failed" }, { status: 500 })
  }
}
