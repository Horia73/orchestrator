/**
 * Report the semantic memory index status: the active embedding generation,
 * how much of the corpus is embedded for it, and which older generations are
 * cached on disk (free to switch back to). Flags drift when the corpus is not
 * fully indexed for the active model.
 *
 * Run: npx tsx scripts/memory-status.ts   (or: npm run memory:status)
 */
export {} // ensure module scope (dynamic-import-only file)

async function main(): Promise<void> {
  const { embeddingsAvailable } = await import("@/lib/memory/embeddings")
  const { getMemoryStatus, isRecallEnabled } = await import(
    "@/lib/memory/recall"
  )

  const status = getMemoryStatus()

  console.log(`Recall enabled:      ${isRecallEnabled() ? "yes" : "no (disabled in Settings or ORCHESTRATOR_MEMORY_RECALL=off)"}`)
  console.log(`Embeddings reachable: ${embeddingsAvailable() ? "yes" : "no (no API key / cooldown)"}`)
  console.log(`Active generation:   ${status.activeModel}@${status.activeDim}`)
  console.log(`Sources on disk:     ${status.sources}`)
  console.log(`Embedded (active):   ${status.activeSources}/${status.sources} source(s), ${status.activeChunks} chunk(s)`)

  if (status.needsIndexing > 0) {
    console.log(
      `\n⚠️  DRIFT: ${status.needsIndexing} source(s) are NOT embedded for the active model.\n` +
        `   Run "npm run backfill:memory" to (re)build the active generation.\n` +
        `   Recall still works on the ${status.activeChunks} already-embedded chunk(s) — partial, never wrong.`
    )
  }

  if (status.generations.length > 0) {
    console.log(`\nGenerations on disk:`)
    for (const g of status.generations) {
      const active = g.model === status.activeModel && g.dim === status.activeDim
      console.log(
        `  - ${g.model}@${g.dim}: ${g.chunks} chunk(s), ${g.sources} source(s)${active ? "  [ACTIVE]" : "  (cached — free to switch back)"}`
      )
    }
  } else {
    console.log(`\nNo generations indexed yet. Run "npm run backfill:memory".`)
  }
}

main().catch((err) => {
  console.error("memory-status failed:", err)
  process.exit(1)
})
