import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

import { activeRuntimePaths } from '@/lib/runtime-paths'

export const AGENT_NEEDS_RELATIVE_PATH = 'AGENT_NEEDS.md'

export const AGENT_NEED_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const
export type AgentNeedSeverity = typeof AGENT_NEED_SEVERITIES[number]

export const AGENT_NEED_CATEGORIES = [
    'missing_capability',
    'tool_failure',
    'runtime_error',
    'permission_blocked',
    'external_dependency',
    'repo_gap',
    'documentation_gap',
    'flaky_test',
    'ambiguous_instruction',
    'automation_blocker',
    'other',
] as const
export type AgentNeedCategory = typeof AGENT_NEED_CATEGORIES[number]

export const AGENT_NEEDS_DEFAULT_CONTENT = [
    '# AGENT_NEEDS',
    '',
    'Operational backlog for things agents could not complete because a capability, tool, integration, runtime behavior, documentation, or repo behavior is missing or broken.',
    '',
    'Agents should add concise entries with `ReportAgentNeed` when available. Humans can triage, edit, move entries to Resolved, or turn them into issues. Do not store secrets, credentials, private tokens, or large logs here.',
    '',
    '## Open',
    '',
    '## Resolved',
    '',
].join('\n')

export interface AgentNeedInput {
    agent?: string
    severity: AgentNeedSeverity
    category: AgentNeedCategory
    summary: string
    attempted?: string
    needed: string
    workaround?: string
    dedupeKey?: string
    source?: string
    conversationId?: string
    runId?: string
    toolCallId?: string
}

export interface AgentNeedRecordResult {
    recorded: boolean
    duplicate: boolean
    path: string
    dedupeKey: string
}

const MAX_FIELD_CHARS = 2000
const MAX_SUMMARY_CHARS = 180

export function recordAgentNeed(input: AgentNeedInput): AgentNeedRecordResult {
    const normalized = normalizeAgentNeed(input)
    const filePath = ensureAgentNeedsFile()
    const content = fs.readFileSync(/* turbopackIgnore: true */ filePath, 'utf-8')
    if (content.includes(`dedupe_key: ${normalized.dedupeKey}`)) {
        return {
            recorded: false,
            duplicate: true,
            path: AGENT_NEEDS_RELATIVE_PATH,
            dedupeKey: normalized.dedupeKey,
        }
    }

    const entry = formatAgentNeedEntry(normalized)
    const next = insertUnderOpen(content, entry)
    fs.writeFileSync(/* turbopackIgnore: true */ filePath, next, 'utf-8')
    return {
        recorded: true,
        duplicate: false,
        path: AGENT_NEEDS_RELATIVE_PATH,
        dedupeKey: normalized.dedupeKey,
    }
}

export function ensureAgentNeedsFile(): string {
    const filePath = path.join(/* turbopackIgnore: true */ activeRuntimePaths().agentWorkspaceDir, AGENT_NEEDS_RELATIVE_PATH)
    fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(filePath), { recursive: true })
    if (!fs.existsSync(/* turbopackIgnore: true */ filePath)) {
        fs.writeFileSync(/* turbopackIgnore: true */ filePath, AGENT_NEEDS_DEFAULT_CONTENT, 'utf-8')
    }
    return filePath
}

export function redactLikelySecrets(value: string): string {
    return value
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/g, 'Bearer [redacted]')
        .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, '[redacted-api-key]')
        .replace(
            /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|authorization)\s*[:=]\s*([^\s,;]+)/gi,
            '$1=[redacted]'
        )
}

function normalizeAgentNeed(input: AgentNeedInput): AgentNeedInput & { dedupeKey: string; timestamp: string } {
    const summary = cleanField(input.summary, MAX_SUMMARY_CHARS).replace(/\s+/g, ' ')
    const needed = cleanField(input.needed, MAX_FIELD_CHARS)
    if (!summary) throw new Error('summary must be a non-empty string.')
    if (!needed) throw new Error('needed must be a non-empty string.')

    const severity = AGENT_NEED_SEVERITIES.includes(input.severity) ? input.severity : 'medium'
    const category = AGENT_NEED_CATEGORIES.includes(input.category) ? input.category : 'other'
    const rawDedupe = cleanDedupeKey(input.dedupeKey)
    const dedupeKey = rawDedupe || generatedDedupeKey(category, summary, needed)

    return {
        ...input,
        agent: cleanField(input.agent ?? '', 80),
        severity,
        category,
        summary,
        attempted: cleanField(input.attempted ?? '', MAX_FIELD_CHARS),
        needed,
        workaround: cleanField(input.workaround ?? '', MAX_FIELD_CHARS),
        source: cleanField(input.source ?? 'agent', 80),
        conversationId: cleanField(input.conversationId ?? '', 120),
        runId: cleanField(input.runId ?? '', 120),
        toolCallId: cleanField(input.toolCallId ?? '', 120),
        dedupeKey,
        timestamp: new Date().toISOString(),
    }
}

function cleanField(value: string, maxChars: number): string {
    const clean = redactLikelySecrets(value).replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim()
    if (clean.length <= maxChars) return clean
    return `${clean.slice(0, maxChars - 24).trimEnd()}\n[truncated]`
}

function cleanDedupeKey(value: string | undefined): string {
    return (value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_.:-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 120)
}

function generatedDedupeKey(category: AgentNeedCategory, summary: string, needed: string): string {
    const hash = crypto
        .createHash('sha1')
        .update(`${category}\n${summary}\n${needed}`)
        .digest('hex')
        .slice(0, 12)
    return `${category}:${hash}`
}

function formatAgentNeedEntry(input: AgentNeedInput & { dedupeKey: string; timestamp: string }): string {
    const title = `### ${input.timestamp} - ${input.severity} - ${input.category} - ${input.summary}`
    const lines = [
        title,
        '',
        `- status: open`,
        `- agent: ${input.agent || 'unknown'}`,
        `- source: ${input.source || 'agent'}`,
        `- dedupe_key: ${input.dedupeKey}`,
    ]
    if (input.conversationId) lines.push(`- conversation_id: ${input.conversationId}`)
    if (input.runId) lines.push(`- run_id: ${input.runId}`)
    if (input.toolCallId) lines.push(`- tool_call_id: ${input.toolCallId}`)
    if (input.attempted) lines.push('', 'Attempted:', '', indentBlock(input.attempted))
    lines.push('', 'Needed:', '', indentBlock(input.needed))
    if (input.workaround) lines.push('', 'Workaround:', '', indentBlock(input.workaround))
    return `${lines.join('\n')}\n\n`
}

function indentBlock(value: string): string {
    return value
        .split('\n')
        .map(line => `> ${line}`)
        .join('\n')
}

function insertUnderOpen(content: string, entry: string): string {
    const normalized = content.trimEnd()
    const openHeading = '## Open'
    const resolvedHeading = '\n## Resolved'
    const openIndex = normalized.indexOf(openHeading)
    if (openIndex === -1) {
        return `${normalized}\n\n${openHeading}\n\n${entry}## Resolved\n`
    }

    const resolvedIndex = normalized.indexOf(resolvedHeading, openIndex)
    if (resolvedIndex === -1) {
        return `${normalized}\n\n${entry}`
    }

    const beforeResolved = normalized.slice(0, resolvedIndex).trimEnd()
    const afterResolved = normalized.slice(resolvedIndex)
    return `${beforeResolved}\n\n${entry}${afterResolved.trimStart()}\n`
}
