import { NextResponse } from "next/server"
import { getAllAgents } from "@/lib/ai"
import { guardSensitiveRequest } from "@/lib/api/request-guard"
import { setAgentOrder } from "@/lib/config"
import { runWithRequestProfile } from "@/lib/profiles/server"

/**
 * PUT — replace the Settings sidebar order for agents.
 * Body: { agentOrder: string[] }. Unknown IDs are dropped; new agents not listed
 * here are appended by the UI in registry order.
 */
export async function PUT(request: Request) {
  return runWithRequestProfile(request, async () => {
      const guard = guardSensitiveRequest(request)
      if (guard) return guard

      let body: unknown
      try {
        body = await request.json()
      } catch {
        return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
      }

      if (
        !body ||
        typeof body !== "object" ||
        !Array.isArray((body as { agentOrder?: unknown }).agentOrder)
      ) {
        return NextResponse.json(
          { error: "Body must be { agentOrder: string[] }" },
          { status: 400 }
        )
      }

      const agentOrder = (body as { agentOrder: unknown[] }).agentOrder
      if (!agentOrder.every((id) => typeof id === "string")) {
        return NextResponse.json(
          { error: "agentOrder entries must be strings" },
          { status: 400 }
        )
      }

      const known = new Set(getAllAgents().map((agent) => agent.id))
      const seen = new Set<string>()
      const cleaned: string[] = []
      for (const id of agentOrder as string[]) {
        const trimmed = id.trim()
        if (!known.has(trimmed) || seen.has(trimmed)) continue
        seen.add(trimmed)
        cleaned.push(trimmed)
      }

      const updated = setAgentOrder(cleaned)
      return NextResponse.json({ success: true, agentOrder: updated.agentOrder })
  })
}
