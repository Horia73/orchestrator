import type { AgentConfig } from './types'
import { buildOrchestratorPrompt } from '@/lib/ai/prompts/orchestrator'
import { CLI_WORKSPACE_BUILTINS, DELEGATING_WORKSPACE_TOOLS, GMAIL_TOOL_IDS, GOOGLE_CALENDAR_TOOL_IDS, GOOGLE_CONTACTS_TOOL_IDS, GOOGLE_DOCS_TOOL_IDS, GOOGLE_DRIVE_TOOL_IDS, GOOGLE_SHEETS_TOOL_IDS, GOOGLE_SLIDES_TOOL_IDS, HOME_ASSISTANT_TOOL_IDS, INTEGRATION_CONTROL_TOOL_IDS, MONITORING_TOOL_IDS, SCHEDULING_TOOL_IDS, WATCHLIST_TOOL_IDS, WEATHER_TOOL_IDS, WHATSAPP_TOOL_IDS } from './builtins'

export const orchestrator: AgentConfig = {
    id: 'orchestrator',
    name: 'Orchestrator',
    description: 'Main router. Handles simple work directly; delegates the rest.',
    kind: 'text',
    buildPrompt: buildOrchestratorPrompt,
    // Declared grant. Integration *operational* tools are gated at runtime by
    // connection status + per-conversation activation (lib/integrations/
    // exposure.ts); only their setup/lifecycle tools and the <integrations>
    // summary are always in context. `builtins` below also enables native
    // equivalents for CLI-backed runs; providers dedupe overlapping defs.
    tools: [...DELEGATING_WORKSPACE_TOOLS, ...SCHEDULING_TOOL_IDS, ...WATCHLIST_TOOL_IDS, ...MONITORING_TOOL_IDS, ...WEATHER_TOOL_IDS, ...INTEGRATION_CONTROL_TOOL_IDS, ...GMAIL_TOOL_IDS, ...WHATSAPP_TOOL_IDS, ...GOOGLE_CALENDAR_TOOL_IDS, ...GOOGLE_DRIVE_TOOL_IDS, ...GOOGLE_CONTACTS_TOOL_IDS, ...GOOGLE_DOCS_TOOL_IDS, ...GOOGLE_SHEETS_TOOL_IDS, ...GOOGLE_SLIDES_TOOL_IDS, ...HOME_ASSISTANT_TOOL_IDS],
    builtins: CLI_WORKSPACE_BUILTINS,
    canCallAgents: [
        'researcher',
        'multipurpose',
        'coder',
        'browser_agent',
        'image_generator',
        'video_generator',
        'speech_generator',
        'music_generator',
        'concierge_agent',
    ],
}
