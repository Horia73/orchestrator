import { NextResponse } from "next/server"
import { guardSensitiveRequest } from "@/lib/api/request-guard"
import { getMemoryStatus, syncMemoryIndex } from "@/lib/memory/recall"
import { embeddingsAvailable, isActiveModelMultimodal } from "@/lib/memory/embeddings"
import { getLibraryStatus, syncLibraryIndex } from "@/lib/memory/library"
import { runWithRequestProfile } from "@/lib/profiles/server"
import { proxyToDurableAiWorker, shouldProxyToDurableAiWorker } from '@/lib/ai/durable-worker'
import { clearAgentRun, registerAgentRun } from '@/lib/agent-runs'
import { randomUUID } from 'crypto'

export async function POST(request: Request) {
  return runWithRequestProfile(request, async () => {
      const guard = guardSensitiveRequest(request)
      if (guard) return guard
      if (shouldProxyToDurableAiWorker()) return proxyToDurableAiWorker(request)

      const runId = `memory_reindex_${randomUUID()}`
      if (!registerAgentRun({
        id: runId,
        kind: 'app',
        conversationId: 'memory-reindex',
        startedAt: Date.now(),
      })) {
        return NextResponse.json(
          { error: 'AI worker generation is changing; retry after reconnect.' },
          { status: 503, headers: { 'Retry-After': '3' } },
        )
      }
      try {
        if (!embeddingsAvailable()) {
          return NextResponse.json(
            {
              error:
                "Embeddings unavailable — set a Google/Gemini API key first. Nothing was indexed.",
              status: getMemoryStatus(),
            },
            { status: 409 }
          )
        }
        const result = await syncMemoryIndex()
        // Library (images/PDFs) only embeds with a multimodal model.
        const library = isActiveModelMultimodal() ? await syncLibraryIndex() : null
        return NextResponse.json({
          success: true,
          result,
          library,
          status: getMemoryStatus(),
          libraryStatus: getLibraryStatus(),
        })
      } catch (error) {
        console.error("Memory reindex failed", error)
        return NextResponse.json(
          { error: "Memory reindex failed" },
          { status: 500 }
        )
      } finally {
        clearAgentRun(runId)
      }
  })
}
