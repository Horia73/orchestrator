import { NextResponse } from "next/server"
import { guardSensitiveRequest } from "@/lib/api/request-guard"
import { EMBEDDING_MODEL_OPTIONS, getMemoryEmbeddingSettings } from "@/lib/config"
import { getActiveThreshold, getMemoryStatus } from "@/lib/memory/recall"
import { embeddingsAvailable, providerHasKey } from "@/lib/memory/embeddings"
import { getThresholds } from "@/lib/memory/store"
import { getLibraryStatus } from "@/lib/memory/library"

export async function GET(request: Request) {
  const guard = guardSensitiveRequest(request)
  if (guard) return guard

  try {
    return NextResponse.json({
      settings: getMemoryEmbeddingSettings(),
      status: getMemoryStatus(),
      libraryStatus: getLibraryStatus(),
      embeddingsAvailable: embeddingsAvailable(),
      activeThreshold: getActiveThreshold(),
      thresholds: getThresholds(),
      providers: {
        google: providerHasKey("google"),
        openai: providerHasKey("openai"),
      },
      options: EMBEDDING_MODEL_OPTIONS,
    })
  } catch (error) {
    console.error("Failed to read memory status", error)
    return NextResponse.json(
      { error: "Failed to read memory status" },
      { status: 500 }
    )
  }
}
