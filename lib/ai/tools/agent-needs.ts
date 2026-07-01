import type { ToolDef, ToolExecutionContext, ToolResult } from '@/lib/ai/agents/types'
import {
    AGENT_NEED_CATEGORIES,
    AGENT_NEED_SEVERITIES,
    recordAgentNeed,
    resolveAgentNeed,
} from '@/lib/agent-needs'
import { getActiveProfileId, isAdminProfileId, normalizeProfileId } from '@/lib/profiles/context'

export const reportAgentNeedTool: ToolDef = {
    id: 'ReportAgentNeed',
    name: 'ReportAgentNeed',
    description: [
        'Append a concise operational backlog entry when an agent is blocked by a missing capability, failed tool, runtime issue, repo/documentation gap, or similar fixable system problem.',
        'After reporting a blocker, stop the blocked execution path and surface the blocker; do not begin a workaround unless the user or parent agent explicitly confirms it.',
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
                profile_id: result.profileId,
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

export const resolveAgentNeedTool: ToolDef = {
    id: 'ResolveAgentNeed',
    name: 'ResolveAgentNeed',
    description: [
        'Move an open AGENT_NEEDS.md entry into the Resolved section once its missing capability/bug has shipped or the need is confirmed obsolete.',
        'Identify the entry by its dedupe_key (the `dedupe_key:` line on each structured entry). Records a short resolution note and timestamp.',
        'Use this to close the loop after a capability-audit proposal is implemented, or when triage confirms a need no longer applies. Admin may pass profile_id to close a need in another profile backlog. Do not invent dedupe keys; if an old hand-written entry has no dedupe_key, move it with the Edit tool instead.',
    ].join(' '),
    input_schema: {
        type: 'object',
        properties: {
            dedupe_key: {
                type: 'string',
                description: 'The dedupe_key of the open entry to resolve, copied verbatim from AGENT_NEEDS.md.',
            },
            resolution: {
                type: 'string',
                description: 'One short line on how it was resolved, e.g. "shipped in <commit/release>" or "obsolete because <reason>".',
            },
            profile_id: {
                type: 'string',
                description: 'Optional target profile id. Admin-only; omit to resolve the active profile\'s AGENT_NEEDS.md.',
            },
        },
        required: ['dedupe_key', 'resolution'],
    },
    tags: ['write', 'agent_feedback'],
}

export function executeResolveAgentNeed(
    args: Record<string, unknown>,
    ctx?: ToolExecutionContext
): ToolResult {
    const dedupeKey = stringValue(args.dedupe_key)
    const resolution = stringValue(args.resolution)
    const requestedProfileId = stringValue(args.profile_id)

    if (!dedupeKey.trim()) return { success: false, error: 'dedupe_key must be a non-empty string.' }
    if (!resolution.trim()) return { success: false, error: 'resolution must be a non-empty string.' }

    try {
        let profileId: string | undefined
        if (requestedProfileId.trim()) {
            profileId = normalizeProfileId(requestedProfileId)
            const activeProfileId = getActiveProfileId()
            if (profileId !== activeProfileId && !isAdminProfileId(activeProfileId)) {
                return {
                    success: false,
                    error: 'profile_id can target another AGENT_NEEDS.md only from the admin profile.',
                }
            }
        }

        const result = resolveAgentNeed({
            dedupeKey,
            resolution,
            resolvedBy: ctx?.callerAgentId,
            profileId,
        })

        if (!result.found) {
            return {
                success: false,
                error: `No open AGENT_NEEDS entry found with dedupe_key "${result.dedupeKey}". Copy it verbatim from AGENT_NEEDS.md, or move a keyless entry with Edit.`,
            }
        }

        return {
            success: true,
            data: {
                path: result.path,
                profile_id: result.profileId,
                resolved: result.resolved,
                dedupe_key: result.dedupeKey,
            },
        }
    } catch (err) {
        return {
            success: false,
            error: err instanceof Error ? err.message : 'Unknown error resolving agent need.',
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
