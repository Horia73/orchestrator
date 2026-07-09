#!/usr/bin/env tsx
import fs from 'fs'
import path from 'path'

import { ORCHESTRATOR_STATE_DIR } from '@/lib/runtime-paths'
import type { MemoryRecallEvalObservation } from '@/lib/memory/eval'

const args = new Map<string, string>()
for (let index = 2; index < process.argv.length; index += 1) {
  const raw = process.argv[index]
  if (!raw.startsWith('--')) continue
  const equals = raw.indexOf('=')
  if (equals >= 0) {
    args.set(raw.slice(2, equals), raw.slice(equals + 1))
  } else {
    const next = process.argv[index + 1]
    if (next && !next.startsWith('--')) {
      args.set(raw.slice(2), next)
      index += 1
    } else {
      args.set(raw.slice(2), 'true')
    }
  }
}

const datasetPath = path.resolve(
  args.get('dataset') ?? path.join(ORCHESTRATOR_STATE_DIR, 'memory-recall-eval.json')
)
const rawLimit = integerArg('raw-limit', 20, 4, 100)
const json = args.get('json') === 'true'

if (!fs.existsSync(datasetPath)) {
  throw new Error(
    `Recall dataset not found: ${datasetPath}. Copy docs/examples/memory-recall-eval.example.json there and replace the example cases with private, user-verified facts.`
  )
}

const { parseMemoryRecallEvalDataset, evaluateMemoryRecall } = await import('@/lib/memory/eval')
const { embeddingsAvailable, getEmbeddingDim, getEmbeddingModel } = await import('@/lib/memory/embeddings')
const {
  evaluateRecallSearch,
  getMemoryStatus,
  syncMemoryIndex,
} = await import('@/lib/memory/recall')

const dataset = parseMemoryRecallEvalDataset(JSON.parse(fs.readFileSync(datasetPath, 'utf-8')))
if (!embeddingsAvailable()) throw new Error('The configured embedding provider/key is unavailable.')

if (args.get('sync') === 'true') {
  const sync = await syncMemoryIndex()
  if (!json) console.log(`Index sync: ${sync.indexed} indexed, ${sync.removed} removed, ${sync.failed} failed.`)
}

const status = getMemoryStatus()
const observations = new Map<string, MemoryRecallEvalObservation>()
for (const testCase of dataset.cases) {
  const preview = await evaluateRecallSearch(testCase.query, rawLimit)
  observations.set(testCase.id, {
    rawHits: preview.rawHits,
    automaticHits: preview.automaticHits,
  })
}
const report = evaluateMemoryRecall(dataset, observations, Math.min(4, rawLimit))

if (json) {
  console.log(JSON.stringify({
    dataset: datasetPath,
    model: getEmbeddingModel(),
    dim: getEmbeddingDim(),
    index: status,
    ...report,
  }, null, 2))
} else {
  const metric = (value: number | null) => value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`
  console.log(`Memory recall eval: ${dataset.cases.length} cases on ${getEmbeddingModel()}@${getEmbeddingDim()}`)
  console.log(`Index coverage: ${status.activeSources}/${status.sources} sources, ${status.activeChunks} chunks, ${status.needsIndexing} pending`)
  console.log(
    `Score ${report.summary.qualityScore.toFixed(1)}/10 · raw R@4 ${metric(report.summary.rawRecallAtK)}`
    + ` · automatic recall ${metric(report.summary.automaticRecall)}`
    + ` · precision ${metric(report.summary.automaticPrecision)}`
    + ` · negative silence ${metric(report.summary.negativeSilenceRate)}`
  )
  for (const result of report.results) {
    const state = result.expectRecall
      ? result.automaticRank !== null ? 'PASS' : 'MISS'
      : result.automaticReturned === 0 ? 'PASS' : 'NOISY'
    console.log(
      `${state.padEnd(5)} ${result.id}: raw rank ${result.rawRank ?? '—'}, automatic rank ${result.automaticRank ?? '—'}, returned ${result.automaticReturned}`
    )
  }
  if (status.needsIndexing > 0) console.log('Warning: index is incomplete; rerun with --sync before treating this score as a baseline.')
}

function integerArg(name: string, fallback: number, min: number, max: number): number {
  const raw = args.get(name)
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`--${name} must be a number.`)
  return Math.max(min, Math.min(max, Math.floor(value)))
}
