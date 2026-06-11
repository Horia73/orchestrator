/**
 * One-time (and repeatable) backfill of the semantic memory index.
 *
 * Embeds every memory source (USER/MEMORY/MONITORS/PLAYBOOKS + the full
 * MEMORY_DAY history + prior conversation user→assistant exchanges) that is
 * new or whose content changed since the last run, using the configured
 * embedding model (Gemini Embedding 2 @ 768 by default). After the switch to
 * exchange-granularity indexing, the first run prunes the legacy per-message
 * sources and embeds the exchange sources in their place.
 * Safe to re-run: unchanged files are skipped via content-hash diffing.
 *
 * Requires a Google/Gemini API key in the environment or workspace .env.local.
 * Without one it exits cleanly having done nothing (fail-open, like the runtime).
 *
 * Run: npx tsx scripts/backfill-memory-embeddings.ts
 */
export {} // ensure module scope (dynamic-import-only file)

async function main(): Promise<void> {
  const { embeddingsAvailable, getEmbeddingModel, getEmbeddingDim } =
    await import("@/lib/memory/embeddings")
  const {
    syncMemoryIndex,
    listMemorySources,
    getMemoryStatus,
    isRecallEnabled,
  } = await import("@/lib/memory/recall")

  if (!isRecallEnabled()) {
    console.log(
      "Semantic memory recall is disabled (ORCHESTRATOR_MEMORY_RECALL=off). Nothing to do."
    )
    return
  }

  if (!embeddingsAvailable()) {
    console.log(
      "No embedding API key found (GEMINI_API_KEY / GOOGLE_API_KEY). Backfill skipped."
    )
    return
  }

  const sources = listMemorySources()
  console.log(
    `Model: ${getEmbeddingModel()} @ ${getEmbeddingDim()}d — ${sources.length} memory source(s).`
  )
  console.log("Indexing (only new/changed sources are embedded)…")

  const started = Date.now()
  const { indexed, removed, failed } = await syncMemoryIndex()
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)

  console.log(
    `Done in ${elapsed}s — indexed ${indexed}, removed ${removed}, failed ${failed}.`
  )
  const status = getMemoryStatus()
  console.log(
    `Active generation ${status.activeModel}@${status.activeDim}: ${status.activeChunks} chunk(s) across ${status.activeSources}/${status.sources} source(s)` +
      (status.needsIndexing > 0
        ? ` (${status.needsIndexing} still need embedding).`
        : ".")
  )
  if (status.generations.length > 1) {
    const others = status.generations
      .filter((g) => !(g.model === status.activeModel && g.dim === status.activeDim))
      .map((g) => `${g.model}@${g.dim} (${g.chunks} chunks)`)
      .join(", ")
    if (others) console.log(`Cached older generations (free to switch back to): ${others}.`)
  }
  if (failed > 0) {
    console.log(
      `${failed} source(s) failed to embed (transient API issue). Re-run to retry.`
    )
  }

  // Library (images/PDFs) — multimodal only.
  const { isActiveModelMultimodal } = await import("@/lib/memory/embeddings")
  const { syncLibraryIndex, getLibraryStatus } = await import("@/lib/memory/library")
  if (isActiveModelMultimodal()) {
    console.log("\nIndexing Library files/images (multimodal)…")
    const lib = await syncLibraryIndex()
    const ls = getLibraryStatus()
    console.log(
      `Library: indexed ${lib.indexed}, removed ${lib.removed}, failed ${lib.failed} — ${ls.indexedActive}/${ls.assetsOnDisk} asset(s) embedded for the active model.`
    )
  } else {
    console.log(
      "\nLibrary image/PDF search skipped: the active model is text-only. Select Gemini Embedding 2 to enable it."
    )
  }
}

main().catch((err) => {
  console.error("backfill-memory-embeddings failed:", err)
  process.exit(1)
})
