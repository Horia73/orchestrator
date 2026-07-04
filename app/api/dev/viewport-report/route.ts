import { NextResponse } from "next/server"
import { runWithRequestProfile } from "@/lib/profiles/server"

export const dynamic = "force-dynamic"

// TEMPORARY diagnostic sink for ViewportProbeReporter (see that component).
// Payloads land in the container log:
//   docker compose logs orchestrator | grep viewport-probe
export async function POST(req: Request) {
  return runWithRequestProfile(req, async () => {
    try {
      const payload = await req.json()
      console.log("[viewport-probe]", JSON.stringify(payload))
    } catch {
      // malformed probe payloads are not worth surfacing
    }
    return new NextResponse(null, { status: 204 })
  })
}
