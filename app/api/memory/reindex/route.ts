import { NextResponse } from "next/server"
import { guardSensitiveRequest } from "@/lib/api/request-guard"
import { getMemoryStatus, syncMemoryIndex } from "@/lib/memory/recall"
import { embeddingsAvailable, isActiveModelMultimodal } from "@/lib/memory/embeddings"
import { getLibraryStatus, syncLibraryIndex } from "@/lib/memory/library"
import { runWithRequestProfile } from "@/lib/profiles/server"

export async function POST(request: Request) {
  return runWithRequestProfile(request, async () => {
      const guard = guardSensitiveRequest(request)
      if (guard) return guard

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
      }
  })
}
