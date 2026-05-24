import { NextResponse } from "next/server"

import { guardSensitiveRequest } from "@/lib/api/request-guard"
import { deleteSmartMapArtifact } from "@/lib/maps/saved-map-artifacts"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const NO_STORE = { "Cache-Control": "no-store" }

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = guardSensitiveRequest(request)
  if (guard) return guard

  const { id } = await params
  if (!deleteSmartMapArtifact(id)) {
    return NextResponse.json(
      { error: "Saved Smart Map not found." },
      { status: 404, headers: NO_STORE }
    )
  }

  return NextResponse.json({ deleted: true }, { headers: NO_STORE })
}
