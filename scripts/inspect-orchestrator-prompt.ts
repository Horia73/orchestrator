/**
 * Dumps a section-by-section breakdown of the orchestrator system prompt
 * with zero activations. Useful for spotting where context goes after the
 * lazy-doctrine refactor.
 *
 * Run: npx tsx scripts/inspect-orchestrator-prompt.ts
 */
import { randomUUID } from 'crypto'
import { orchestrator } from '@/lib/ai/agents/orchestrator'
import { MAX_AGENT_DEPTH } from '@/lib/ai/agents/types'

if (!orchestrator.buildPrompt) throw new Error('Orchestrator has no buildPrompt')
const prompt = orchestrator.buildPrompt({
    agentId: orchestrator.id,
    userName: 'Test',
    assistantName: 'Test',
    availableTools: [],
    availableBuiltins: [],
    availableAgents: [],
    conversationId: `inspect-${randomUUID()}`,
    declaredToolIds: orchestrator.tools,
    delegationDepth: 0,
    maxDelegationDepth: MAX_AGENT_DEPTH,
})

const totalChars = prompt.length
const totalTokens = Math.round(totalChars / 4)
console.log(`Total prompt: ${totalChars.toLocaleString()} chars (~${totalTokens.toLocaleString()} tokens at 4ch/tok)\n`)

// Split by top-level XML-style opening tags <name> ... </name> at column 0.
// We also catch a couple of plain headings (Tools available, Native ...).
interface Section { name: string; start: number; end: number; size: number }

const sections: Section[] = []
const tagPattern = /^<([a-z_][a-z0-9_]*)>$/gm
let match: RegExpExecArray | null
while ((match = tagPattern.exec(prompt)) !== null) {
    const name = match[1]
    const start = match.index
    const closing = `</${name}>`
    const endIdx = prompt.indexOf(closing, start)
    if (endIdx === -1) continue
    const end = endIdx + closing.length
    sections.push({ name, start, end, size: end - start })
}

// Sort by start position, then drop nested matches (keep only top-level).
sections.sort((a, b) => a.start - b.start)
const topLevel: Section[] = []
for (const s of sections) {
    const enclosing = topLevel.find(t => t.start <= s.start && t.end >= s.end)
    if (!enclosing) topLevel.push(s)
}

console.log('Sections (top-level XML blocks, in prompt order):')
console.log('─'.repeat(78))
let covered = 0
for (const s of topLevel) {
    const tokens = Math.round(s.size / 4)
    const pct = ((s.size / totalChars) * 100).toFixed(1)
    console.log(
        `  ${s.name.padEnd(38)}  ${String(s.size).padStart(7)} chars  ~${String(tokens).padStart(5)} tok  ${pct.padStart(4)}%`
    )
    covered += s.size
}
console.log('─'.repeat(78))
const remaining = totalChars - covered
const remainingTokens = Math.round(remaining / 4)
const remainingPct = ((remaining / totalChars) * 100).toFixed(1)
console.log(
    `  ${'(connective text / runtime context lines / file blocks)'.padEnd(38)}  ${String(remaining).padStart(7)} chars  ~${String(remainingTokens).padStart(5)} tok  ${remainingPct.padStart(4)}%`
)
console.log('─'.repeat(78))
console.log(`  ${'TOTAL'.padEnd(38)}  ${String(totalChars).padStart(7)} chars  ~${String(totalTokens).padStart(5)} tok  100.0%`)

// Show the non-XML connective bits (between sections). These are the lines
// the model still sees but that don't belong to a tagged block — typically
// runtime_context plain lines, the workspace files BEGIN/END markers, and
// short headings.
const gaps: { start: number; end: number; preview: string }[] = []
let cursor = 0
for (const s of topLevel) {
    if (s.start > cursor) {
        const slice = prompt.slice(cursor, s.start).trim()
        if (slice.length > 0) {
            gaps.push({
                start: cursor,
                end: s.start,
                preview: slice.slice(0, 120).replace(/\s+/g, ' '),
            })
        }
    }
    cursor = s.end
}
if (cursor < prompt.length) {
    const slice = prompt.slice(cursor).trim()
    if (slice.length > 0) {
        gaps.push({
            start: cursor,
            end: prompt.length,
            preview: slice.slice(0, 120).replace(/\s+/g, ' '),
        })
    }
}

if (gaps.length > 0) {
    console.log('\nConnective / unbracketed text segments:')
    console.log('─'.repeat(78))
    for (const g of gaps) {
        const size = g.end - g.start
        if (size < 40) continue
        const tokens = Math.round(size / 4)
        console.log(`  ${String(size).padStart(6)} chars (~${tokens} tok) — ${g.preview}…`)
    }
}
