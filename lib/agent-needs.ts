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

export interface AgentNeedResolveInput {
    dedupeKey: string
    resolution: string
    resolvedBy?: string
}

export interface AgentNeedResolveResult {
    resolved: boolean
    found: boolean
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

/** Move an open entry (identified by its dedupe_key) into the Resolved section,
 *  flipping its status and appending a short resolution note + timestamp. Used
 *  to close the loop after a capability audit proposal ships or a need is
 *  confirmed obsolete. Returns found=false when no open entry carries the key
 *  (e.g. an old hand-written entry with no dedupe_key — edit those directly). */
export function resolveAgentNeed(input: AgentNeedResolveInput): AgentNeedResolveResult {
    const dedupeKey = cleanDedupeKey(input.dedupeKey)
    if (!dedupeKey) throw new Error('dedupeKey must be a non-empty string.')
    const resolution = cleanField(input.resolution ?? '', MAX_FIELD_CHARS)
    if (!resolution) throw new Error('resolution must be a non-empty string.')
    const resolvedBy = cleanField(input.resolvedBy ?? '', 80)

    const filePath = ensureAgentNeedsFile()
    const content = fs.readFileSync(/* turbopackIgnore: true */ filePath, 'utf-8')
    const next = moveEntryToResolved(content, dedupeKey, resolution, resolvedBy, new Date().toISOString())
    if (!next) {
        return { resolved: false, found: false, path: AGENT_NEEDS_RELATIVE_PATH, dedupeKey }
    }
    fs.writeFileSync(/* turbopackIgnore: true */ filePath, next, 'utf-8')
    return { resolved: true, found: true, path: AGENT_NEEDS_RELATIVE_PATH, dedupeKey }
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

/** Split a section body into its leading preamble (non-entry text) and the
 *  individual `### ` entry blocks. */
function splitEntryBlocks(body: string): { preamble: string; blocks: string[] } {
    const lines = body.split('\n')
    const preamble: string[] = []
    const blocks: string[] = []
    let current: string[] | null = null
    for (const line of lines) {
        if (line.startsWith('### ')) {
            if (current) blocks.push(current.join('\n').trim())
            current = [line]
        } else if (current) {
            current.push(line)
        } else {
            preamble.push(line)
        }
    }
    if (current) blocks.push(current.join('\n').trim())
    return {
        preamble: preamble.join('\n').trim(),
        blocks: blocks.filter(Boolean),
    }
}

function entryHasDedupeKey(block: string, dedupeKey: string): boolean {
    return new RegExp(`^- dedupe_key: ${escapeRegExp(dedupeKey)}\\s*$`, 'm').test(block)
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Flip an entry block to resolved: set status, stamp resolved_at/by, and
 *  append a Resolution note. */
function markEntryResolved(
    block: string,
    resolution: string,
    resolvedBy: string,
    timestamp: string
): string {
    const stamp = [`- resolved_at: ${timestamp}`]
    if (resolvedBy) stamp.push(`- resolved_by: ${resolvedBy}`)

    let updated: string
    if (/^- status:.*$/m.test(block)) {
        updated = block.replace(/^- status:.*$/m, `- status: resolved\n${stamp.join('\n')}`)
    } else {
        // No status line (older shape): add the metadata right after the title.
        const nl = block.indexOf('\n')
        const head = nl === -1 ? block : block.slice(0, nl)
        const rest = nl === -1 ? '' : block.slice(nl + 1)
        updated = [head, '', `- status: resolved`, ...stamp, rest].join('\n')
    }
    return `${updated.trimEnd()}\n\nResolution:\n\n${indentBlock(resolution)}`.trim()
}

/** Move the open entry carrying `dedupeKey` into the Resolved section. Returns
 *  the rewritten file content, or null when no such open entry exists. */
function moveEntryToResolved(
    content: string,
    dedupeKey: string,
    resolution: string,
    resolvedBy: string,
    timestamp: string
): string | null {
    const openHeading = '## Open'
    const resolvedHeading = '## Resolved'
    const openIndex = content.indexOf(openHeading)
    if (openIndex === -1) return null

    const resolvedIndex = content.indexOf(resolvedHeading, openIndex)
    const openBodyStart = openIndex + openHeading.length
    const openBodyEnd = resolvedIndex === -1 ? content.length : resolvedIndex
    const head = content.slice(0, openBodyStart).trimEnd() // ends with "## Open"
    const openBody = content.slice(openBodyStart, openBodyEnd)
    const resolvedBody =
        resolvedIndex === -1 ? '' : content.slice(resolvedIndex + resolvedHeading.length)

    const open = splitEntryBlocks(openBody)
    const matchIndex = open.blocks.findIndex((b) => entryHasDedupeKey(b, dedupeKey))
    if (matchIndex === -1) return null

    const entry = markEntryResolved(open.blocks[matchIndex], resolution, resolvedBy, timestamp)
    const remainingOpen = open.blocks.filter((_, i) => i !== matchIndex)
    const resolved = splitEntryBlocks(resolvedBody)

    const openPart = [open.preamble, ...remainingOpen].map((s) => s.trim()).filter(Boolean).join('\n\n')
    const resolvedPart = [resolved.preamble, entry, ...resolved.blocks]
        .map((s) => s.trim())
        .filter(Boolean)
        .join('\n\n')

    let out = `${head}\n\n`
    if (openPart) out += `${openPart}\n\n`
    out += `${resolvedHeading}\n\n`
    if (resolvedPart) out += `${resolvedPart}\n`
    return `${out.replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}
