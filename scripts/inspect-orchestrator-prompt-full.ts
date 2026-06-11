/**
 * Like inspect-orchestrator-prompt.ts but with the REAL exposed tool surface
 * (Tier-1 filter applied, like app/api/chat/route.ts) so <runtime_tools> and
 * agent roster are measured too. Throwaway analysis script.
 *
 * Run: npx tsx scripts/inspect-orchestrator-prompt-full.ts
 */
import { randomUUID } from 'crypto'
import { orchestrator } from '@/lib/ai/agents/orchestrator'
import { MAX_AGENT_DEPTH } from '@/lib/ai/agents/types'
import type { AgentConfig, ToolDef } from '@/lib/ai/agents/types'
import { getToolsForAgent, getToolsForBuiltins } from '@/lib/ai/tools/registry'
import { filterIntegrationToolExposure } from '@/lib/integrations/exposure'
import { getAgent } from '@/lib/ai/agents/registry'

function dedupeTools<T extends { id: string }>(tools: T[]): T[] {
    const seen = new Set<string>()
    return tools.filter(t => (seen.has(t.id) ? false : (seen.add(t.id), true)))
}

const conversationId = `inspect-${randomUUID()}`
const candidateTools = filterIntegrationToolExposure(
    dedupeTools([
        ...getToolsForAgent(orchestrator.tools),
        ...getToolsForBuiltins(orchestrator.builtins ?? []),
    ]),
    { conversationId, agentId: orchestrator.id }
)

function isAgentConfig(agent: AgentConfig | undefined): agent is AgentConfig {
    return agent !== undefined
}

const availableAgents = (orchestrator.canCallAgents ?? [])
    .map(id => getAgent(id))
    .filter(isAgentConfig)

const declared = getToolsForAgent(orchestrator.tools)
console.log(`declared tools: ${declared.length}, exposed (tier-1, zero activations): ${candidateTools.length}`)

const prompt = orchestrator.buildPrompt!({
    agentId: orchestrator.id,
    userName: 'Test',
    assistantName: 'Test',
    availableTools: candidateTools,
    availableBuiltins: orchestrator.builtins ?? [],
    availableAgents,
    conversationId,
    declaredToolIds: orchestrator.tools,
    declaredTools: declared,
    delegationDepth: 0,
    maxDelegationDepth: MAX_AGENT_DEPTH,
})

const totalChars = prompt.length
console.log(`Total prompt: ${totalChars.toLocaleString()} chars (~${Math.round(totalChars / 4).toLocaleString()} tokens at 4ch/tok)\n`)

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
    sections.push({ name, start, end: endIdx + closing.length, size: endIdx + closing.length - start })
}
sections.sort((a, b) => a.start - b.start)
const topLevel: Section[] = []
for (const s of sections) {
    if (!topLevel.find(t => t.start <= s.start && t.end >= s.end)) topLevel.push(s)
}
let covered = 0
for (const s of topLevel) {
    const pct = ((s.size / totalChars) * 100).toFixed(1)
    console.log(`  ${s.name.padEnd(38)} ${String(s.size).padStart(7)} chars ~${String(Math.round(s.size / 4)).padStart(5)} tok ${pct.padStart(5)}%`)
    covered += s.size
}
console.log(`  ${'(uncovered)'.padEnd(38)} ${String(totalChars - covered).padStart(7)} chars`)

// Tool schema cost OUTSIDE the prompt: what the provider sends as tool defs.
const schemaJson = JSON.stringify(candidateTools.map((t: ToolDef) => ({ name: t.name, description: t.description, input_schema: t.input_schema })))
console.log(`\nProvider tool definitions payload (separate from system prompt): ${schemaJson.length.toLocaleString()} chars (~${Math.round(schemaJson.length / 4).toLocaleString()} tok) across ${candidateTools.length} tools`)

// Top 15 heaviest tools by schema size
const weighted = candidateTools.map((t: ToolDef) => ({
    name: t.name,
    size: JSON.stringify({ d: t.description, s: t.input_schema }).length,
})).sort((a, b) => b.size - a.size)
console.log('\nHeaviest always-on tool defs:')
for (const t of weighted.slice(0, 20)) {
    console.log(`  ${t.name.padEnd(36)} ${String(t.size).padStart(6)} chars ~${Math.round(t.size / 4)} tok`)
}

console.log('\nAll exposed tier-1 tools:')
for (const t of candidateTools) console.log(`  - ${t.name}`)
