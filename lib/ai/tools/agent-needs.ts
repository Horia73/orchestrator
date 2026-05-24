import type { ToolDef, ToolExecutionContext, ToolResult } from '@/lib/ai/agents/types'
import {
    AGENT_NEED_CATEGORIES,
    AGENT_NEED_SEVERITIES,
    recordAgentNeed,
} from '@/lib/agent-needs'

export const reportAgentNeedTool: ToolDef = {
    id: 'ReportAgentNeed',
    name: 'ReportAgentNeed',
    description: [
        'Append a concise operational backlog entry when an agent is blocked by a missing capability, failed tool, runtime issue, repo/documentation gap, or similar fixable system problem.',
        'Do not use this for ordinary user follow-up questions, per-task todos, or low-level logs.',
        'Never include secrets, credentials, tokens, private keys, or large transcripts.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            severity: {
                type: 'string',
                enum: [...AGENT_NEED_SEVERITIES],
                description: 'Impact of the blocker. Use critical only when it prevents a core workflow broadly.',
            },
            category: {
                type: 'string',
                enum: [...AGENT_NEED_CATEGORIES],
                description: 'Kind of fix needed.',
            },
            summary: {
                type: 'string',
                description: 'One short, concrete sentence describing the problem.',
            },
            attempted: {
                type: 'string',
                description: 'What was attempted before reporting this. Keep it brief.',
            },
            needed: {
                type: 'string',
                description: 'The missing capability, tool behavior, integration, doc, permission, or code change needed.',
            },
            workaround: {
                type: 'string',
                description: 'Any partial workaround used or suggested.',
            },
            dedupe_key: {
                type: 'string',
                description: 'Optional stable key for duplicate suppression, e.g. browser-download-verification.',
            },
        },
        required: ['severity', 'category', 'summary', 'needed'],
    },
    tags: ['write', 'agent_feedback'],
}

export function executeReportAgentNeed(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext
): ToolResult {
    const severity = parseEnum(args.severity, AGENT_NEED_SEVERITIES)
    const category = parseEnum(args.category, AGENT_NEED_CATEGORIES)
    const summary = stringValue(args.summary)
    const needed = stringValue(args.needed)

    if (!severity) return { success: false, error: 'severity must be one of: low, medium, high, critical.' }
    if (!category) return { success: false, error: `category must be one of: ${AGENT_NEED_CATEGORIES.join(', ')}.` }
    if (!summary.trim()) return { success: false, error: 'summary must be a non-empty string.' }
    if (!needed.trim()) return { success: false, error: 'needed must be a non-empty string.' }

    try {
        const result = recordAgentNeed({
            severity,
            category,
            summary,
            needed,
            attempted: stringValue(args.attempted),
            workaround: stringValue(args.workaround),
            dedupeKey: stringValue(args.dedupe_key),
            agent: ctx?.callerAgentId,
            conversationId: ctx?.conversationId,
            runId: ctx?.parentRequestId,
            toolCallId: ctx?.currentToolCallId,
            source: 'ReportAgentNeed',
        })

        return {
            success: true,
            data: {
                path: result.path,
                recorded: result.recorded,
                duplicate: result.duplicate,
                dedupe_key: result.dedupeKey,
            },
        }
    } catch (err) {
        return {
            success: false,
            error: err instanceof Error ? err.message : 'Unknown error reporting agent need.',
        }
    }
}

function stringValue(value: unknown): string {
    return typeof value === 'string' ? value : ''
}

function parseEnum<T extends string>(value: unknown, allowed: readonly T[]): T | null {
    if (typeof value !== 'string') return null
    return allowed.includes(value as T) ? value as T : null
}
