import type { AgentConfig } from './types'
import { buildWorkerPrompt } from '@/lib/ai/prompts/worker'
import { CLI_WORKSPACE_BUILTINS, DELEGATING_WORKSPACE_TOOLS, GOOGLE_CONTACTS_TOOL_IDS, GOOGLE_DOCS_TOOL_IDS, GOOGLE_DRIVE_TOOL_IDS, GOOGLE_SHEETS_TOOL_IDS, GOOGLE_SLIDES_TOOL_IDS, INTEGRATION_CONTROL_TOOL_IDS, SKILL_TOOL_IDS, TRANSCRIPTION_TOOL_IDS, UPLOADS_TOOL_IDS } from './builtins'

export const worker: AgentConfig = {
    id: 'worker',
    name: 'Worker',
    description: 'General-purpose worker: reasoning, structured analysis, synthesis, drafting, and heavy docs/decks/sheets — fresh context, returns one result.',
    kind: 'text',
    buildPrompt: buildWorkerPrompt,
    // Heavy doc/deck/sheet deliverables need Google Workspace; operational
    // schemas are gated at runtime by connection status + activation
    // (lib/integrations/exposure.ts). No Gmail/Calendar/WhatsApp/Home Assistant.
    tools: [...DELEGATING_WORKSPACE_TOOLS, ...SKILL_TOOL_IDS, ...UPLOADS_TOOL_IDS, ...TRANSCRIPTION_TOOL_IDS, ...INTEGRATION_CONTROL_TOOL_IDS, ...GOOGLE_DRIVE_TOOL_IDS, ...GOOGLE_CONTACTS_TOOL_IDS, ...GOOGLE_DOCS_TOOL_IDS, ...GOOGLE_SHEETS_TOOL_IDS, ...GOOGLE_SLIDES_TOOL_IDS],
    builtins: CLI_WORKSPACE_BUILTINS,
    // Narrow escape hatch only (see <scope_and_escape_hatch>): researcher for a
    // fact it lacks, browser_agent to verify one page, self for independent
    // sub-passes. NOT coder / concierge / media — those stay orchestrator-
    // routed. The runtime withholds delegation at MAX_AGENT_DEPTH, so nesting
    // stays bounded no matter how deep this worker was itself spawned.
    canCallAgents: ['researcher', 'browser_agent', 'worker'],
}
