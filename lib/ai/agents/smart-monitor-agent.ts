import type { AgentConfig } from './types'
import { orchestrator } from './orchestrator'
import {
    APPS_TOOL_IDS,
    BACKUP_TOOL_IDS,
    PROFILE_ADMIN_TOOL_IDS,
    QUESTION_TOOL_IDS,
    REMOTE_ACCESS_TOOL_IDS,
    SKILL_TOOL_IDS,
    TRANSCRIPTION_TOOL_IDS,
    UPDATE_TOOL_IDS,
    UPLOADS_TOOL_IDS,
    WORKOUT_HISTORY_TOOL_IDS,
} from './builtins'

// ---------------------------------------------------------------------------
// Smart Monitor alias of the orchestrator.
//
// Same underlying orchestrator runtime, but with a wake-specific prompt pack,
// a lean tool grant, and Researcher-only delegation. Settings still shows a
// dedicated card whose provider/model override applies only when the Smart
// Monitor heartbeat wakes on matches. This keeps autonomous turns focused and
// lets the user route them to a different subscription/model.
// ---------------------------------------------------------------------------

const SMART_MONITOR_EXCLUDED_TOOLS = new Set([
    ...APPS_TOOL_IDS,
    ...BACKUP_TOOL_IDS,
    ...PROFILE_ADMIN_TOOL_IDS,
    ...QUESTION_TOOL_IDS,
    ...REMOTE_ACCESS_TOOL_IDS,
    ...SKILL_TOOL_IDS,
    ...TRANSCRIPTION_TOOL_IDS,
    ...UPDATE_TOOL_IDS,
    ...UPLOADS_TOOL_IDS,
    ...WORKOUT_HISTORY_TOOL_IDS,
    // Wake runs finish synchronously and surface through Inbox; they must not
    // launch orphan background jobs or create nested fan-out trees.
    'start_background_job',
    'manage_background_jobs',
    'delegate_parallel',
    'TodoWrite',
    'ListEnvVars',
    'SetEnv',
    'ResolveAgentNeed',
    // Exact active watch records are already in the wake packet. Lifecycle
    // mutation belongs to user conversations, not autonomous evaluation.
    'monitor_describe_sources',
    'monitor_watch_list',
    'monitor_watch_get',
    'monitor_watch_add',
    'monitor_watch_update',
    'monitor_watch_remove',
])

export const smartMonitorAgent: AgentConfig = {
    ...orchestrator,
    id: 'smart-monitor-agent',
    name: 'Smart Monitor',
    description: 'Wakes on Smart Monitor matches; decides notify/action.',
    tier: 'system',
    tools: orchestrator.tools.filter(toolId => !SMART_MONITOR_EXCLUDED_TOOLS.has(toolId)),
    canCallAgents: ['researcher'],
}
