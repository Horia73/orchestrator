import type { MemoryHit } from '@/lib/memory/recall'

export interface MemoryRecallMatchRule {
  id?: string
  source?: string
  sourcePrefix?: string
  titleIncludes?: string
  textIncludes?: string
}

export interface MemoryRecallEvalCase {
  id: string
  query: string
  /** Defaults to true. Negative/no-recall cases set this to false. */
  expectRecall?: boolean
  /** Any matching rule makes a hit relevant; fields inside one rule are ANDed. */
  relevant?: MemoryRecallMatchRule[]
  note?: string
}

export interface MemoryRecallEvalDataset {
  version: 1
  description?: string
  cases: MemoryRecallEvalCase[]
}

export interface MemoryRecallEvalObservation {
  rawHits: MemoryHit[]
  automaticHits: MemoryHit[]
}

export interface MemoryRecallCaseResult {
  id: string
  expectRecall: boolean
  rawRank: number | null
  automaticRank: number | null
  rawReturned: number
  automaticReturned: number
  automaticRelevant: number
  automaticUnexpected: number
  topRawScore: number | null
  topRelevantRawScore: number | null
}

export interface MemoryRecallEvalSummary {
  cases: number
  positiveCases: number
  negativeCases: number
  rawRecallAt1: number | null
  rawRecallAtK: number | null
  rawMrr: number | null
  automaticRecall: number | null
  automaticMrr: number | null
  automaticPrecision: number
  negativeSilenceRate: number | null
  qualityScore: number
}

export interface MemoryRecallEvalReport {
  summary: MemoryRecallEvalSummary
  results: MemoryRecallCaseResult[]
}

export function parseMemoryRecallEvalDataset(value: unknown): MemoryRecallEvalDataset {
  if (!value || typeof value !== 'object') throw new Error('Dataset must be a JSON object.')
  const raw = value as Record<string, unknown>
  if (raw.version !== 1) throw new Error('Dataset version must be 1.')
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) {
    throw new Error('Dataset must contain at least one case.')
  }

  const ids = new Set<string>()
  const cases = raw.cases.map((entry, index): MemoryRecallEvalCase => {
    if (!entry || typeof entry !== 'object') throw new Error(`Case ${index + 1} must be an object.`)
    const item = entry as Record<string, unknown>
    const id = stringField(item.id)
    const query = stringField(item.query)
    if (!id) throw new Error(`Case ${index + 1} needs a non-empty id.`)
    if (ids.has(id)) throw new Error(`Duplicate case id: ${id}`)
    ids.add(id)
    if (query.length < 8) throw new Error(`Case ${id} query must be at least 8 characters.`)
    const expectRecall = item.expectRecall !== false
    const relevant = Array.isArray(item.relevant)
      ? item.relevant.map((rule, ruleIndex) => parseRule(rule, id, ruleIndex))
      : []
    if (expectRecall && relevant.length === 0) {
      throw new Error(`Positive case ${id} needs at least one relevant match rule.`)
    }
    if (!expectRecall && relevant.length > 0) {
      throw new Error(`Negative case ${id} cannot define relevant hits.`)
    }
    return {
      id,
      query,
      expectRecall,
      relevant,
      ...(typeof item.note === 'string' && item.note.trim() ? { note: item.note.trim() } : {}),
    }
  })

  return {
    version: 1,
    ...(typeof raw.description === 'string' && raw.description.trim()
      ? { description: raw.description.trim() }
      : {}),
    cases,
  }
}

export function memoryHitMatchesRule(hit: MemoryHit, rule: MemoryRecallMatchRule): boolean {
  if (rule.id && hit.id !== rule.id) return false
  if (rule.source && hit.source !== rule.source) return false
  if (rule.sourcePrefix && !hit.source.startsWith(rule.sourcePrefix)) return false
  if (rule.titleIncludes && !includesFolded(hit.title, rule.titleIncludes)) return false
  if (rule.textIncludes && !includesFolded(hit.text, rule.textIncludes)) return false
  return true
}

export function evaluateMemoryRecall(
  dataset: MemoryRecallEvalDataset,
  observations: Map<string, MemoryRecallEvalObservation>,
  rawK = 4
): MemoryRecallEvalReport {
  const results = dataset.cases.map((testCase): MemoryRecallCaseResult => {
    const observation = observations.get(testCase.id)
    if (!observation) throw new Error(`Missing observation for case ${testCase.id}.`)
    const rules = testCase.relevant ?? []
    const isRelevant = (hit: MemoryHit) => rules.some(rule => memoryHitMatchesRule(hit, rule))
    const rawRank = firstRank(observation.rawHits, isRelevant)
    const automaticRank = firstRank(observation.automaticHits, isRelevant)
    const automaticRelevant = observation.automaticHits.filter(isRelevant).length
    return {
      id: testCase.id,
      expectRecall: testCase.expectRecall !== false,
      rawRank,
      automaticRank,
      rawReturned: observation.rawHits.length,
      automaticReturned: observation.automaticHits.length,
      automaticRelevant,
      automaticUnexpected: observation.automaticHits.length - automaticRelevant,
      topRawScore: observation.rawHits[0]?.score ?? null,
      topRelevantRawScore: rawRank ? observation.rawHits[rawRank - 1]?.score ?? null : null,
    }
  })

  const positives = results.filter(result => result.expectRecall)
  const negatives = results.filter(result => !result.expectRecall)
  const returned = results.reduce((sum, result) => sum + result.automaticReturned, 0)
  const relevantReturned = positives.reduce((sum, result) => sum + result.automaticRelevant, 0)
  const rawRecallAt1 = ratio(positives.filter(result => result.rawRank === 1).length, positives.length)
  const rawRecallAtK = ratio(
    positives.filter(result => result.rawRank !== null && result.rawRank <= rawK).length,
    positives.length
  )
  const automaticRecall = ratio(
    positives.filter(result => result.automaticRank !== null).length,
    positives.length
  )
  const automaticPrecision = returned > 0 ? relevantReturned / returned : 1
  const negativeSilenceRate = ratio(
    negatives.filter(result => result.automaticReturned === 0).length,
    negatives.length
  )
  const summary: MemoryRecallEvalSummary = {
    cases: results.length,
    positiveCases: positives.length,
    negativeCases: negatives.length,
    rawRecallAt1,
    rawRecallAtK,
    rawMrr: meanReciprocalRank(positives.map(result => result.rawRank)),
    automaticRecall,
    automaticMrr: meanReciprocalRank(positives.map(result => result.automaticRank)),
    automaticPrecision,
    negativeSilenceRate,
    qualityScore: qualityScore({
      rawRecallAtK,
      automaticRecall,
      automaticPrecision,
      negativeSilenceRate,
    }),
  }
  return { summary, results }
}

function parseRule(value: unknown, caseId: string, index: number): MemoryRecallMatchRule {
  if (!value || typeof value !== 'object') {
    throw new Error(`Relevant rule ${index + 1} in ${caseId} must be an object.`)
  }
  const raw = value as Record<string, unknown>
  const rule: MemoryRecallMatchRule = {
    ...(stringField(raw.id) ? { id: stringField(raw.id) } : {}),
    ...(stringField(raw.source) ? { source: stringField(raw.source) } : {}),
    ...(stringField(raw.sourcePrefix) ? { sourcePrefix: stringField(raw.sourcePrefix) } : {}),
    ...(stringField(raw.titleIncludes) ? { titleIncludes: stringField(raw.titleIncludes) } : {}),
    ...(stringField(raw.textIncludes) ? { textIncludes: stringField(raw.textIncludes) } : {}),
  }
  if (Object.keys(rule).length === 0) {
    throw new Error(`Relevant rule ${index + 1} in ${caseId} needs at least one matcher.`)
  }
  return rule
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function includesFolded(haystack: string, needle: string): boolean {
  return haystack.toLocaleLowerCase().includes(needle.toLocaleLowerCase())
}

function firstRank(hits: MemoryHit[], predicate: (hit: MemoryHit) => boolean): number | null {
  const index = hits.findIndex(predicate)
  return index >= 0 ? index + 1 : null
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null
}

function meanReciprocalRank(ranks: Array<number | null>): number | null {
  if (ranks.length === 0) return null
  return ranks.reduce<number>((sum, rank) => sum + (rank ? 1 / rank : 0), 0) / ranks.length
}

function qualityScore(input: {
  rawRecallAtK: number | null
  automaticRecall: number | null
  automaticPrecision: number
  negativeSilenceRate: number | null
}): number {
  const components = [
    { value: input.rawRecallAtK, weight: 0.2 },
    { value: input.automaticRecall, weight: 0.4 },
    { value: input.automaticPrecision, weight: 0.2 },
    { value: input.negativeSilenceRate, weight: 0.2 },
  ].filter((item): item is { value: number; weight: number } => item.value !== null)
  const totalWeight = components.reduce((sum, item) => sum + item.weight, 0)
  if (totalWeight === 0) return 0
  const value = components.reduce((sum, item) => sum + item.value * item.weight, 0) / totalWeight
  return Math.round(value * 100) / 10
}
