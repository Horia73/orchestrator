import { NextResponse } from "next/server"
import {
  DEFAULT_RUN_HISTORY_PAGE_SIZE,
  listTaskRunsPage,
  parseTaskRunCursor,
  type TaskRunFilters,
} from "@/lib/scheduling/store"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const url = new URL(request.url)
    const limitParam = url.searchParams.get("limit")
    const beforeParam = url.searchParams.get("before")
    const limit = limitParam
      ? Number(limitParam)
      : DEFAULT_RUN_HISTORY_PAGE_SIZE
    const before = beforeParam ? parseTaskRunCursor(beforeParam) : null
    const statusParam = url.searchParams.get("status")
    const triggerParam = url.searchParams.get("trigger")
    const surfacedParam = url.searchParams.get("surfaced")

    if (beforeParam && !before) {
      return NextResponse.json({ error: "Invalid run cursor" }, { status: 400 })
    }
    if (statusParam && statusParam !== "ok" && statusParam !== "error") {
      return NextResponse.json(
        { error: "Invalid run status filter" },
        { status: 400 }
      )
    }
    if (
      triggerParam &&
      triggerParam !== "schedule" &&
      triggerParam !== "manual"
    ) {
      return NextResponse.json(
        { error: "Invalid run trigger filter" },
        { status: 400 }
      )
    }
    if (
      surfacedParam &&
      surfacedParam !== "true" &&
      surfacedParam !== "false"
    ) {
      return NextResponse.json(
        { error: "Invalid run surfaced filter" },
        { status: 400 }
      )
    }

    const status =
      statusParam === "ok" || statusParam === "error" ? statusParam : undefined
    const trigger =
      triggerParam === "schedule" || triggerParam === "manual"
        ? triggerParam
        : undefined
    const filters: TaskRunFilters = {
      ...(status ? { status } : {}),
      ...(trigger ? { trigger } : {}),
      ...(surfacedParam ? { surfaced: surfacedParam === "true" } : {}),
    }

    return NextResponse.json(listTaskRunsPage(id, { limit, before, filters }))
  } catch (error) {
    console.error("Failed to list task runs", error)
    return NextResponse.json(
      { error: "Failed to list task runs" },
      { status: 500 }
    )
  }
}
