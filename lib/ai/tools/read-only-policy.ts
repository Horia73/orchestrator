import type { ToolDef } from '@/lib/ai/agents/types'

// Read-only wake runs may gather context and notify, but they must not mutate
// local runtime state, user files, or external sources through hidden fallback
// calls. Keep this policy centralized so the advertised tool list and
// RunActivatedIntegrationTool enforcement cannot drift.

const ALWAYS_ALLOWED_READ_ONLY_WAKE_TOOLS = new Set([
    'notify_inbox',
    'ActivateIntegrationTools',
    'RunActivatedIntegrationTool',
])

const DENIED_READ_ONLY_WAKE_TAGS = new Set([
    'write',
    'external_action',
    'destructive',
    'execute',
    'shell',
    'secret',
    'system',
    'delegation',
    'task_tracking',
    'setup',
    'filesystem',
])

const CONTEXT_ONLY_TAGS = new Set([
    'read',
    'memory',
    'library',
    'workout',
    'workout-history',
    'weather',
    'maps',
])

export function isReadOnlyWakeToolAllowed(tool: ToolDef): boolean {
    if (ALWAYS_ALLOWED_READ_ONLY_WAKE_TOOLS.has(tool.id)) return true
    if (tool.tags.some((tag) => DENIED_READ_ONLY_WAKE_TAGS.has(tag))) return false
    return tool.tags.some((tag) => CONTEXT_ONLY_TAGS.has(tag))
}

export function readOnlyWakeToolError(tool: ToolDef): string {
    return [
        `${tool.id} is not available in this read-only wake.`,
        'Microscript agent.wake runs may activate and read context, then notify Inbox, but they cannot perform source-side writes, setup, scheduling, filesystem changes, delegation, or destructive actions.',
    ].join(' ')
}
