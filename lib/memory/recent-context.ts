/**
 * Prompt-only extractive compaction for raw memory files.
 *
 * MEMORY_DAY and durable USER/PLAYBOOKS sources remain complete on disk and in
 * the semantic index. The prompt only needs bounded orientation views. This
 * module therefore performs deterministic, extractive compaction: every
 * markdown entry is represented, while long entries keep their beginning and
 * ending with an explicit pointer back to the untouched raw file.
 */

export const RECENT_DAILY_CONTEXT_DAYS = 3
export const MAX_RECENT_DAILY_CONTEXT_CHARS = 30_000
export const MAX_USER_CONTEXT_CHARS = 28_000
export const MAX_PLAYBOOKS_CONTEXT_CHARS = 18_000
export const MAX_MONITORS_CONTEXT_CHARS = 30_000

const BASE_ENTRY_CHARS = 96
const MAX_ENTRY_CHARS = 800
const MIN_SPLIT_CONTEXT_CHARS = 36

export interface RecentDailyMemorySource {
  relativePath: string
  content: string
}

export interface RecentDailyMemoryBlock {
  relativePath: string
  content: string
  rawChars: number
  entryCount: number
  compacted: boolean
}

interface ParsedSource {
  relativePath: string
  raw: string
  entries: string[]
  header: string
  recencyWeight: number
}

interface EntryAllocation {
  sourceIndex: number
  entryIndex: number
  text: string
  desiredChars: number
  allocatedChars: number
  weight: number
}

/**
 * Return a bounded prompt view of recent daily-memory files.
 *
 * When the raw files already fit, they are returned verbatim. When they do
 * not, all parsed entries remain represented; long entries are shortened
 * extractively rather than summarized or classified, so this path never
 * decides that a saved fact is unimportant.
 */
export function compactRecentDailyMemory(
  sources: RecentDailyMemorySource[],
  maxChars = MAX_RECENT_DAILY_CONTEXT_CHARS,
  viewLabel = "recent-memory"
): RecentDailyMemoryBlock[] {
  const clean = sources
    .map((source) => ({
      relativePath: source.relativePath,
      content: source.content.replace(/\r\n/g, "\n").trim(),
    }))
    .filter((source) => source.content.length > 0)

  if (clean.length === 0 || maxChars <= 0) return []

  const rawChars = clean.reduce((sum, source) => sum + source.content.length, 0)
  if (rawChars <= maxChars) {
    return clean.map((source) => ({
      relativePath: source.relativePath,
      content: source.content,
      rawChars: source.content.length,
      entryCount: splitDailyMemoryEntries(source.content).length,
      compacted: false,
    }))
  }

  const parsed: ParsedSource[] = clean.map((source, sourceIndex) => {
    const entries = splitDailyMemoryEntries(source.content)
    const safeEntries =
      entries.length > 0 ? entries : [normalizeWhitespace(source.content)]
    const recencyWeight =
      clean.length <= 1 ? 1 : 0.85 + (0.3 * sourceIndex) / (clean.length - 1)
    const header = compactViewHeader(
      source.relativePath,
      source.content.length,
      safeEntries.length,
      viewLabel
    )
    return {
      relativePath: source.relativePath,
      raw: source.content,
      entries: safeEntries,
      header,
      recencyWeight,
    }
  })

  const fixedChars = parsed.reduce(
    (sum, source) => sum + source.header.length + source.entries.length * 3,
    Math.max(0, parsed.length - 1)
  )
  // If canonical context leaves too little room even for one marker per saved
  // entry, skip the orientation view entirely. The untouched files remain
  // available through recall/read; silently dropping a subset here would be
  // more misleading than omitting the compact view as a whole.
  if (fixedChars > maxChars) return []
  const entryBudget = Math.max(0, maxChars - fixedChars)
  const allocations = allocateEntryChars(parsed, entryBudget)
  const bySource = new Map<number, EntryAllocation[]>()
  for (const allocation of allocations) {
    const list = bySource.get(allocation.sourceIndex) ?? []
    list.push(allocation)
    bySource.set(allocation.sourceIndex, list)
  }

  return parsed.map((source, sourceIndex): RecentDailyMemoryBlock => {
    const entries = (bySource.get(sourceIndex) ?? [])
      .sort((a, b) => a.entryIndex - b.entryIndex)
      .map((entry) => `- ${compactEntry(entry.text, entry.allocatedChars)}`)
    return {
      relativePath: source.relativePath,
      content: [source.header, ...entries].join("\n"),
      rawChars: source.raw.length,
      entryCount: source.entries.length,
      compacted: true,
    }
  })
}

/** Compact one durable markdown file with the same no-selection guarantee. */
export function compactMemoryFileForPrompt(
  source: RecentDailyMemorySource,
  maxChars: number,
  viewLabel: string
): RecentDailyMemoryBlock | null {
  return compactRecentDailyMemory([source], maxChars, viewLabel)[0] ?? null
}

/** Split markdown into semantic ledger entries while keeping continuations. */
export function splitDailyMemoryEntries(content: string): string[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n")
  const entries: string[] = []
  let heading = ""
  let current: string[] = []
  let currentIsBullet = false

  const flush = (): void => {
    if (current.length === 0) return
    const text = normalizeWhitespace(current.join(" "))
    current = []
    currentIsBullet = false
    if (!text) return
    const prefix =
      heading && !isGenericDailyHeading(heading) ? `${heading}: ` : ""
    entries.push(`${prefix}${text}`)
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) {
      if (!currentIsBullet) flush()
      continue
    }

    const headingMatch = /^#{1,6}\s+(.*)$/.exec(line)
    if (headingMatch) {
      flush()
      heading = normalizeWhitespace(headingMatch[1])
      continue
    }

    const bulletMatch = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line)
    if (bulletMatch) {
      flush()
      current = [bulletMatch[1]]
      currentIsBullet = true
      continue
    }

    current.push(line)
  }
  flush()
  return entries
}

function compactViewHeader(
  relativePath: string,
  rawChars: number,
  entryCount: number,
  viewLabel: string
): string {
  return `[compact ${viewLabel} view: all ${entryCount} saved entr${entryCount === 1 ? "y is" : "ies are"} represented; raw=${rawChars} chars. Omitted spans remain intact in ${relativePath}, are semantic-recall eligible, and can be read directly when exact detail matters.]`
}

function allocateEntryChars(
  parsed: ParsedSource[],
  budget: number
): EntryAllocation[] {
  const allocations: EntryAllocation[] = []
  for (let sourceIndex = 0; sourceIndex < parsed.length; sourceIndex++) {
    const source = parsed[sourceIndex]
    for (let entryIndex = 0; entryIndex < source.entries.length; entryIndex++) {
      const text = source.entries[entryIndex]
      allocations.push({
        sourceIndex,
        entryIndex,
        text,
        desiredChars: Math.min(MAX_ENTRY_CHARS, text.length),
        allocatedChars: 0,
        weight: source.recencyWeight,
      })
    }
  }
  if (allocations.length === 0 || budget <= 0) return allocations

  const equalShare = Math.floor(budget / allocations.length)
  const baseline = Math.max(1, Math.min(BASE_ENTRY_CHARS, equalShare))
  for (const entry of allocations) {
    entry.allocatedChars = Math.min(entry.desiredChars, baseline)
  }

  let remaining =
    budget - allocations.reduce((sum, entry) => sum + entry.allocatedChars, 0)
  let candidates = allocations.filter(
    (entry) => entry.allocatedChars < entry.desiredChars
  )
  while (remaining > 0 && candidates.length > 0) {
    const totalWeight = candidates.reduce((sum, entry) => sum + entry.weight, 0)
    let distributed = 0
    for (const entry of candidates) {
      const fairShare = Math.max(
        1,
        Math.floor((remaining * entry.weight) / totalWeight)
      )
      const added = Math.min(
        fairShare,
        entry.desiredChars - entry.allocatedChars
      )
      entry.allocatedChars += added
      distributed += added
    }
    if (distributed <= 0) break
    remaining -= distributed
    candidates = candidates.filter(
      (entry) => entry.allocatedChars < entry.desiredChars
    )
  }
  return allocations
}

function compactEntry(text: string, maxChars: number): string {
  if (maxChars <= 0) return ""
  if (text.length <= maxChars) return text
  if (maxChars < MIN_SPLIT_CONTEXT_CHARS)
    return text.slice(0, maxChars).trimEnd()

  const markerFor = (omitted: number) => ` [... +${omitted} chars in raw ...] `
  let marker = markerFor(Math.max(1, text.length - maxChars))
  const payloadBudget = Math.max(2, maxChars - marker.length)
  const headBudget = Math.max(1, Math.floor(payloadBudget * 0.64))
  const tailBudget = Math.max(1, payloadBudget - headBudget)
  const head = trimHeadAtBoundary(text, headBudget)
  const tail = trimTailAtBoundary(text, tailBudget)
  const omitted = Math.max(1, text.length - head.length - tail.length)
  marker = markerFor(omitted)

  const result = `${head}${marker}${tail}`
  if (result.length <= maxChars) return result
  const overflow = result.length - maxChars
  return `${head.slice(0, Math.max(1, head.length - overflow)).trimEnd()}${marker}${tail}`
}

function trimHeadAtBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const slice = text.slice(0, maxChars)
  const boundary = slice.lastIndexOf(" ")
  return (
    boundary >= Math.floor(maxChars * 0.6) ? slice.slice(0, boundary) : slice
  ).trimEnd()
}

function trimTailAtBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const slice = text.slice(text.length - maxChars)
  const boundary = slice.indexOf(" ")
  return (
    boundary >= 0 && boundary <= Math.floor(maxChars * 0.4)
      ? slice.slice(boundary + 1)
      : slice
  ).trimStart()
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim()
}

function isGenericDailyHeading(value: string): boolean {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
  return normalized === "memory day" || normalized.startsWith("memory day 20")
}
