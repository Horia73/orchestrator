/**
 * Smoke tests for the semantic memory recall layer (lib/memory/*).
 *
 * Runs fully offline and deterministically: no embedding API is called. We
 * chdir into a throwaway state dir and strip any embedding key from the env so
 * the embeddings backend is "unavailable", then exercise:
 *  - chunkMarkdown: bullet/paragraph splitting, heading titles, template-noise
 *    and short-line filtering, and the defensive max-chunk-size cap.
 *  - store (multi-generation): content marker + FTS, embedding generations keyed
 *    by (source, model, dim), Float32 round-trip, generation isolation in search,
 *    FREE switch-back (old generation retained), prune-on-content-change, status.
 *  - searchMemoryForTool: keyword fallback when embeddings are unavailable.
 *  - buildRecalledMemoryContext / formatRecallBlock: fail-open + output shape.
 *
 * Run: npx tsx scripts/smoke-memory-recall.ts
 */
import fs from "fs"
import os from "os"
import path from "path"

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-recall-smoke-"))
process.chdir(tmpRoot)
// Force the embeddings backend offline/unavailable for deterministic tests.
delete process.env.GEMINI_API_KEY
delete process.env.GOOGLE_API_KEY
delete process.env.GOOGLE_GENERATIVE_AI_API_KEY
delete process.env.ORCHESTRATOR_MEMORY_RECALL

let failures = 0
function check(label: string, cond: unknown, detail?: unknown): void {
  const ok = Boolean(cond)
  if (!ok) failures += 1
  console.log(
    `${ok ? "✓" : "✗"} ${label}${ok ? "" : "  (" + JSON.stringify(detail) + ")"}`
  )
}

function unit(arr: number[]): Float32Array {
  let norm = 0
  for (const x of arr) norm += x * x
  norm = Math.sqrt(norm) || 1
  return Float32Array.from(arr.map((x) => x / norm))
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i] * b[i]
  return s
}

async function main(): Promise<void> {
  const recall = await import("@/lib/memory/recall")
  const store = await import("@/lib/memory/store")
  const { embeddingsAvailable } = await import("@/lib/memory/embeddings")

  check("embeddings unavailable offline (no key)", embeddingsAvailable() === false)

  // --- chunkMarkdown -------------------------------------------------------
  const md = [
    "# MEMORY",
    "",
    "Permanent memory belongs here.", // template noise -> skipped
    "",
    "## Project Aurora",
    "- Decided to use Postgres for the analytics store for window functions.",
    "- short", // too short -> skipped
    "",
    "A longer freeform paragraph about the migration plan and its tradeoffs.",
  ].join("\n")
  const chunks = recall.chunkMarkdown("MEMORY.md", md)
  check("chunkMarkdown yields 2 signal chunks", chunks.length === 2, chunks)
  check(
    "bullet chunk captured with heading title",
    chunks[0]?.text.includes("Postgres") &&
      chunks[0]?.title.includes("Project Aurora"),
    chunks[0]
  )
  check(
    "template noise filtered out",
    chunks.every((c) => !c.text.toLowerCase().includes("permanent memory belongs here"))
  )

  // defensive max-chunk cap
  const huge = ["# H", "", "x".repeat(20000)].join("\n")
  const hugeChunks = recall.chunkMarkdown("BIG.md", huge)
  check(
    "huge chunk is capped to a safe size",
    hugeChunks.length === 1 && hugeChunks[0].text.length <= 4000,
    hugeChunks[0]?.text.length
  )

  // --- conversation sources ------------------------------------------------
  const { createConversation } = await import("@/lib/db")
  createConversation({
    id: "conv_memory_smoke",
    title: "Kitchen moodboard",
    createdAt: 1_735_689_600_000,
    updatedAt: 1_735_689_600_000,
    messages: [
      {
        id: "msg_memory_smoke_user",
        role: "user",
        content: "Remember the green tile photo for the kitchen moodboard.",
        attachments: [
          {
            id: "00000000-0000-4000-8000-000000000000.png",
            filename: "tile.png",
            mimeType: "image/png",
            size: 123,
            type: "image",
          },
        ],
        timestamp: 1_735_689_600_000,
      },
    ],
  })
  const conversationSource = "conversation:conv_memory_smoke:msg_memory_smoke_user"
  check(
    "listMemorySources includes user conversation messages",
    recall.listMemorySources().includes(conversationSource),
    recall.listMemorySources()
  )
  const conversationChunks = recall.chunkConversationContent(
    conversationSource,
    [
      "Conversation: Kitchen moodboard",
      "Conversation ID: conv_memory_smoke",
      "Message ID: msg_memory_smoke_user",
      "Date: 2025-01-01T00:00:00.000Z",
      "Role: User",
      "Attachments: tile.png",
      "",
      "Remember the green tile photo for the kitchen moodboard.",
    ].join("\n")
  )
  check(
    "chunkConversationContent keeps conversation title + attachment context",
    conversationChunks.length === 1 &&
      conversationChunks[0].title.includes("Kitchen moodboard") &&
      conversationChunks[0].text.includes("tile.png"),
    conversationChunks
  )

  // --- hot/cold tier: inContextSources exclusion + indexing ----------------
  const { activeRuntimePaths: arp } = await import("@/lib/runtime-paths")
  const wsDir = arp().agentWorkspaceDir
  fs.mkdirSync(wsDir, { recursive: true })
  fs.writeFileSync(path.join(wsDir, "USER.md"), "# USER\n\nsmall hot file")
  fs.writeFileSync(path.join(wsDir, "MEMORY.md"), "# MEMORY\n\nsmall hot file")
  fs.writeFileSync(path.join(wsDir, "PLAYBOOKS.md"), "# PLAYBOOKS\n\nsmall hot file")
  fs.writeFileSync(path.join(wsDir, "MONITORS.md"), "# MONITORS\n\ncold for the plain orchestrator")
  fs.writeFileSync(path.join(wsDir, "MEMORY_ARCHIVE.md"), "# MEMORY ARCHIVE\n\narchived durable fact about grapes")
  const ctxSrc = recall.inContextSources()
  check(
    "inContextSources excludes the hot tier (USER/MEMORY/PLAYBOOKS)",
    ctxSrc.has("USER.md") && ctxSrc.has("MEMORY.md") && ctxSrc.has("PLAYBOOKS.md"),
    [...ctxSrc]
  )
  check(
    "inContextSources leaves the cold tier recall-reachable (MONITORS + archive NOT excluded)",
    !ctxSrc.has("MONITORS.md") && !ctxSrc.has("MEMORY_ARCHIVE.md"),
    [...ctxSrc]
  )
  // Overflow guard: a hot file past the per-file budget keeps its tail reachable.
  fs.writeFileSync(path.join(wsDir, "MEMORY.md"), "# MEMORY\n\n" + "x".repeat(50_000))
  check(
    "inContextSources re-enables an overflowed hot file (truncated tail stays recall-reachable)",
    !recall.inContextSources().has("MEMORY.md")
  )
  const indexed = recall.listMemorySources()
  check(
    "listMemorySources indexes the cold tier (MEMORY_ARCHIVE.md + MONITORS.md)",
    indexed.includes("MEMORY_ARCHIVE.md") && indexed.includes("MONITORS.md"),
    indexed
  )

  // --- store: content marker + generations --------------------------------
  store.clearMemoryIndex()
  const dim = 4
  const src = "MEMORY_DAY/2025-01-01.md"
  const contentChunks = [
    { chunkIndex: 0, title: "old", text: "alpha apples orchard harvest" },
    { chunkIndex: 1, title: "old", text: "beta bananas market stall" },
  ]
  store.markContentChanged(src, "h1", contentChunks)
  check("content marker recorded", store.getContentHash(src) === "h1")

  // model A generation
  store.writeGeneration(src, "model-a", dim, "h1", [
    { ...contentChunks[0], embedding: unit([1, 0, 0, 0]) },
    { ...contentChunks[1], embedding: unit([0, 1, 0, 0]) },
  ])
  // model B generation (same content, different space)
  store.writeGeneration(src, "model-b", dim, "h1", [
    { ...contentChunks[0], embedding: unit([0, 0, 1, 0]) },
    { ...contentChunks[1], embedding: unit([0, 0, 0, 1]) },
  ])

  const rowsA = store.loadVectorRows("model-a", dim)
  const rowsB = store.loadVectorRows("model-b", dim)
  check("generation A isolated (2 rows)", rowsA.length === 2, rowsA.length)
  check("generation B isolated (2 rows)", rowsB.length === 2, rowsB.length)
  const appleA = rowsA.find((r) => r.text.includes("apples"))
  check(
    "Float32 BLOB round-trips per generation",
    appleA !== undefined && Math.abs(appleA.vector[0] - 1) < 1e-6 && appleA.vector[2] === 0,
    appleA?.vector
  )
  check(
    "generations live in different vector spaces",
    rowsB.find((r) => r.text.includes("apples"))?.vector[2] === 1
  )

  // cosine ranks within the active generation
  const q = unit([0.9, 0.1, 0, 0])
  const ranked = [...rowsA].sort((a, b) => dot(q, b.vector) - dot(q, a.vector))
  check("cosine ranks the apple chunk first (gen A)", ranked[0]?.text.includes("apples"))

  // FREE switch-back: both generations fresh for current content
  check("generation A is fresh for h1", store.generationFresh(src, "model-a", dim, "h1"))
  check("generation B is fresh for h1", store.generationFresh(src, "model-b", dim, "h1"))
  check("a never-used model is NOT fresh", store.generationFresh(src, "model-z", dim, "h1") === false)

  const status1 = store.getStatus("model-a", dim)
  check("status: 2 generations cached", status1.generations.length === 2, status1.generations)
  check("status: active fully embedded", status1.needsIndexing === 0 && status1.activeSources === 1)

  // --- prune on content change --------------------------------------------
  const newChunks = [{ chunkIndex: 0, title: "old", text: "gamma grapes vineyard rows" }]
  store.markContentChanged(src, "h2", newChunks)
  check("content change wipes ALL stale generations", store.loadVectorRows("model-a", dim).length === 0)
  check("content change: generation A no longer fresh for h2", store.generationFresh(src, "model-a", dim, "h2") === false)
  check("content marker updated to h2", store.getContentHash(src) === "h2")

  // --- FTS keyword index (content-keyed) ----------------------------------
  if (store.isFtsAvailable()) {
    const fts = store.ftsSearch('"grapes"', 5)
    check("FTS reflects new content (grapes)", fts.some((h) => h.text.includes("grapes")), fts)
    check("FTS dropped old content (bananas)", store.ftsSearch('"bananas"', 5).length === 0)
  } else {
    console.log("• FTS5 unavailable in this SQLite build — skipping FTS checks")
  }

  // --- tool keyword fallback (no embeddings) -------------------------------
  if (store.isFtsAvailable()) {
    const toolRes = await recall.searchMemoryForTool("grapes vineyard", 5)
    check(
      "searchMemoryForTool falls back to keyword hits with no key",
      toolRes.semanticUsed === false && toolRes.hits.some((h) => h.text.includes("grapes")),
      toolRes
    )
  }

  // --- formatRecallBlock + fail-open --------------------------------------
  const block = recall.formatRecallBlock([
    { id: "x", source: src, title: `${src} › X`, text: "some old note worth recalling", score: 0.71 },
  ])
  check("formatRecallBlock wraps in <recalled_memory>", block.startsWith("<recalled_memory>"))
  check("formatRecallBlock includes score + text", block.includes("relevance 0.71") && block.includes("some old note"))
  check("formatRecallBlock empty for no hits", recall.formatRecallBlock([]) === "")
  check("formatRecallNote summarizes hits", recall.formatRecallNote([
    { id: "x", source: src, title: src, text: "t", score: 0.7 },
  ]).includes("Memory recall"))

  check("per-turn recall empty with no key (fail-open)", (await recall.buildRecalledMemoryContext("a reasonably long query about grapes")) === "")
  check("per-turn recall empty for trivial query", (await recall.buildRecalledMemoryContext("hi")) === "")
  check("per-turn recall empty for null query", (await recall.buildRecalledMemoryContext(null)) === "")
  check(
    "per-turn recall empty with an attachment but no key (fail-open)",
    (
      await recall.getRecalledMemory("a reasonably long query about grapes", [
        { path: "/nonexistent.png", mimeType: "image/png" },
      ])
    ).block === ""
  )

  // --- formatFilesBlock: similar-files block from an attachment -------------
  const fblock = recall.formatFilesBlock([
    {
      id: "file:/x/diagram.png",
      source: "files/diagram.png",
      title: "files/diagram.png",
      text: "",
      score: 0.82,
      kind: "file",
    },
  ])
  check("formatFilesBlock wraps in <similar_files>", fblock.startsWith("<similar_files>"))
  check(
    "formatFilesBlock includes the file path + relevance without filler text",
    fblock.includes("files/diagram.png") &&
      fblock.includes("relevance 0.82") &&
      !fblock.includes("similar image")
  )
  check("formatFilesBlock empty for no hits", recall.formatFilesBlock([]) === "")

  // --- selectDiverse: near-duplicate suppression --------------------------
  // Three candidates: A and B are near-identical (dot ~0.999), C is orthogonal.
  // Dedup must collapse A/B to the higher-scoring one and keep C.
  const vA = unit([1, 0, 0, 0])
  const vB = unit([0.999, 0.045, 0, 0]) // ~0.999 cosine to A -> near-duplicate
  const vC = unit([0, 0, 1, 0]) // orthogonal -> distinct
  const cand = [
    { id: "a", source: src, title: "t", text: "fact one", score: 0.8 },
    { id: "b", source: src, title: "t", text: "fact one (re-logged)", score: 0.75 },
    { id: "c", source: src, title: "t", text: "different fact", score: 0.7 },
  ]
  const vmap = new Map<string, Float32Array>([
    ["a", vA],
    ["b", vB],
    ["c", vC],
  ])
  const diverse = recall.selectDiverse(cand, vmap, 4)
  check(
    "selectDiverse collapses near-duplicates, keeps distinct",
    diverse.length === 2 && diverse[0].id === "a" && diverse[1].id === "c",
    diverse.map((h) => h.id)
  )
  check(
    "selectDiverse keeps the higher-scoring of a duplicate pair",
    diverse.every((h) => h.id !== "b")
  )
  // No vectors => nothing to compare => all pass through (e.g. FTS-only hits).
  check(
    "selectDiverse passes through vectorless hits",
    recall.selectDiverse(cand, new Map(), 4).length === 3
  )

  // --- repeat suppression: hide repeated marginal hits, keep strong ones ------
  const repeated = recall.suppressRepeatedRecallHits(
    [
      { id: "old", source: src, title: "t", text: "same marginal note", score: 0.7 },
      { id: "strong", source: src, title: "t", text: "same but very relevant", score: 0.82 },
      { id: "fresh", source: src, title: "t", text: "new note", score: 0.69 },
    ],
    new Map<string, number>([
      ["old", 0.72],
      ["strong", 0.8],
    ])
  )
  check(
    "repeat suppression drops repeated marginal hits",
    repeated.every((h) => h.id !== "old"),
    repeated.map((h) => h.id)
  )
  check(
    "repeat suppression keeps strong or fresh hits",
    repeated.some((h) => h.id === "strong") && repeated.some((h) => h.id === "fresh"),
    repeated.map((h) => h.id)
  )

  // --- splitQuerySegments: broad multi-intent message ---------------------
  const broad =
    "vreau o singura boxa pe noptiera, wifi, wake word instant si quality > apple. HA doar ca e misto, dar streaming AI as face local? nu e limita de buget. on/off rapid nu stam dupa un RPI"
  const segs = recall.splitQuerySegments(broad)
  check(
    "splitQuerySegments splits a broad message into >= 4 segments",
    segs.length >= 4,
    segs
  )
  check(
    "splitQuerySegments does not over-split on commas (one intent stays whole)",
    segs.some((s) => s.includes("wifi") && s.includes("wake word")),
    segs
  )
  check(
    "splitQuerySegments stays whole on a short single-intent message",
    recall.splitQuerySegments("remind me about the HA quiet hours").length < 4
  )

  // --- library (multimodal) fail-open without a key -----------------------
  const library = await import("@/lib/memory/library")
  const { activeRuntimePaths } = await import("@/lib/runtime-paths")
  fs.mkdirSync(activeRuntimePaths().uploadsDir, { recursive: true })
  fs.writeFileSync(
    path.join(activeRuntimePaths().uploadsDir, "00000000-0000-4000-8000-000000000000.png"),
    Buffer.from("png")
  )
  check("library: chat upload assets retain source conversation", (() => {
    const assets = library.listLibraryAssets()
    const asset = assets.find((a) => a.assetKey === "upload:00000000-0000-4000-8000-000000000000.png")
    return asset?.conversationId === "conv_memory_smoke" &&
      asset?.messageId === "msg_memory_smoke_user"
  })())
  const libStatus = library.getLibraryStatus()
  // multimodal reflects the MODEL capability (default gemini-embedding-2 = yes);
  // with no key nothing is embedded, so indexedActive stays 0.
  check("library: multimodal-capable model, nothing indexed without key", libStatus.multimodal === true && libStatus.indexedActive === 0)
  check("library: searchLibrary empty without multimodal", (await library.searchLibrary("a red car", 5)).length === 0)
  check(
    "library: searchLibraryByVector empty on empty index",
    (await library.searchLibraryByVector(unit([1, 0, 0, 0]), 3)).length === 0
  )
  const libSync = await library.syncLibraryIndex()
  check("library: sync is a no-op without multimodal", libSync.indexed === 0 && libSync.failed === 0)

  // --- prune source / clear -----------------------------------------------
  store.pruneSource(src)
  check("pruneSource clears content marker", store.getContentHash(src) === null)
  store.clearMemoryIndex()
  check("getMemoryStatus works after clear", recall.getMemoryStatus().sources === 0)

  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch {
    /* best effort */
  }

  if (failures > 0) {
    console.error(`\nsmoke:memory-recall FAILED (${failures} check(s))`)
    process.exit(1)
  }
  console.log("\nsmoke:memory-recall PASS")
}

main().catch((err) => {
  console.error("smoke:memory-recall crashed:", err)
  process.exit(1)
})
