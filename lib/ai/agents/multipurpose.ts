import type { AgentConfig } from './types'
import { buildMultipurposePrompt } from '@/lib/ai/prompts/multipurpose'
import { CLI_WORKSPACE_BUILTINS, DELEGATING_WORKSPACE_TOOLS, GOOGLE_CONTACTS_TOOL_IDS, GOOGLE_DOCS_TOOL_IDS, GOOGLE_DRIVE_TOOL_IDS, GOOGLE_SHEETS_TOOL_IDS, GOOGLE_SLIDES_TOOL_IDS, INTEGRATION_CONTROL_TOOL_IDS } from './builtins'

export const multipurpose: AgentConfig = {
    id: 'multipurpose',
    name: 'Multipurpose',
    description: 'Heavy non-code work: docs, slides, structured analysis.',
    kind: 'text',
    buildPrompt: buildMultipurposePrompt,
    // Heavy doc/deck/sheet work needs Google Workspace. Drive + Docs + Sheets +
    // Slides only — no Gmail/Calendar/WhatsApp/Home Assistant. Operational
    // schemas are gated by connection status + activation at runtime
    // (lib/integrations/exposure.ts).
    tools: [...DELEGATING_WORKSPACE_TOOLS, ...INTEGRATION_CONTROL_TOOL_IDS, ...GOOGLE_DRIVE_TOOL_IDS, ...GOOGLE_CONTACTS_TOOL_IDS, ...GOOGLE_DOCS_TOOL_IDS, ...GOOGLE_SHEETS_TOOL_IDS, ...GOOGLE_SLIDES_TOOL_IDS],
    builtins: CLI_WORKSPACE_BUILTINS,
    // Self-delegation allowed for independent passes; runtime settings pick the model.
    // Depth cap prevents recursion blow-up.
    canCallAgents: ['multipurpose'],
}
