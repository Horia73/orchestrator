import assert from 'assert'

import {
  evaluateMemoryRecall,
  parseMemoryRecallEvalDataset,
  type MemoryRecallEvalObservation,
} from '@/lib/memory/eval'
import type { MemoryHit } from '@/lib/memory/recall'

const dataset = parseMemoryRecallEvalDataset({
  version: 1,
  cases: [
    {
      id: 'positive-top1',
      query: 'What database did we select for analytics?',
      relevant: [{ source: 'MEMORY.md', textIncludes: 'Postgres' }],
    },
    {
      id: 'positive-rank2',
      query: 'Which tiles were chosen for the kitchen?',
      relevant: [{ sourcePrefix: 'conversation:kitchen:', textIncludes: 'green tile' }],
    },
    {
      id: 'negative',
      query: 'What is my preferred submarine color?',
      expectRecall: false,
    },
  ],
})

const observations = new Map<string, MemoryRecallEvalObservation>([
  ['positive-top1', {
    rawHits: [hit('a', 'MEMORY.md', 'Use Postgres for analytics', 0.82)],
    automaticHits: [hit('a', 'MEMORY.md', 'Use Postgres for analytics', 0.79)],
  }],
  ['positive-rank2', {
    rawHits: [
      hit('noise', 'MEMORY_DAY/2026-01-01.md', 'Kitchen delivery window', 0.74),
      hit('tile', 'conversation:kitchen:msg', 'We chose the green tile sample', 0.72),
    ],
    automaticHits: [hit('tile', 'conversation:kitchen:msg', 'We chose the green tile sample', 0.7)],
  }],
  ['negative', {
    rawHits: [hit('noise-2', 'MEMORY.md', 'Blue status LED', 0.4)],
    automaticHits: [],
  }],
])

const report = evaluateMemoryRecall(dataset, observations, 4)
assert.equal(report.summary.rawRecallAt1, 0.5)
assert.equal(report.summary.rawRecallAtK, 1)
assert.equal(report.summary.automaticRecall, 1)
assert.equal(report.summary.automaticPrecision, 1)
assert.equal(report.summary.negativeSilenceRate, 1)
assert.equal(report.summary.qualityScore, 10)
assert.equal(report.results.find(result => result.id === 'positive-rank2')?.rawRank, 2)
assert.throws(() => parseMemoryRecallEvalDataset({ version: 1, cases: [{ id: 'bad', query: 'short' }] }))

console.log('memory recall evaluation smoke tests passed')

function hit(id: string, source: string, text: string, score: number): MemoryHit {
  return { id, source, title: source, text, score }
}
