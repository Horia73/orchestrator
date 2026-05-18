import type { AgentConfig } from './types'
import { buildConciergePrompt } from '@/lib/ai/prompts/concierge'
import { CLI_WORKSPACE_BUILTINS, DELEGATING_WORKSPACE_TOOLS, GMAIL_TOOL_IDS, GOOGLE_CALENDAR_TOOL_IDS, GOOGLE_CONTACTS_TOOL_IDS, GOOGLE_DOCS_TOOL_IDS, GOOGLE_DRIVE_TOOL_IDS, GOOGLE_SHEETS_TOOL_IDS, GOOGLE_SLIDES_TOOL_IDS, INTEGRATION_CONTROL_TOOL_IDS, WHATSAPP_TOOL_IDS } from './builtins'

/**
 * Concierge agent.
 *
 * Text-runtime coordinator for real-world tasks. It can prepare, research,
 * coordinate browser/mobile/phone execution, and stop cleanly at consent
 * boundaries. Some downstream executors may still be planned or provider-stubbed;
 * the runtime roster tells the prompt what is actually callable.
 */
export const conciergeAgent: AgentConfig = {
    id: 'concierge_agent',
    name: 'Concierge agent',
    description: 'Elite real-world concierge for travel, bookings, reservations, purchases, calls, mobile-app tasks, and follow-ups.',
    kind: 'concierge',
    buildPrompt: buildConciergePrompt,
    // No Home Assistant: a concierge handling travel/bookings/calls has no use
    // for smart-home control. Integration operational tools are gated at
    // runtime (lib/integrations/exposure.ts); only setup/lifecycle tools and
    // the <integrations> summary are always in context.
    tools: [...DELEGATING_WORKSPACE_TOOLS, ...INTEGRATION_CONTROL_TOOL_IDS, ...GMAIL_TOOL_IDS, ...WHATSAPP_TOOL_IDS, ...GOOGLE_CALENDAR_TOOL_IDS, ...GOOGLE_DRIVE_TOOL_IDS, ...GOOGLE_CONTACTS_TOOL_IDS, ...GOOGLE_DOCS_TOOL_IDS, ...GOOGLE_SHEETS_TOOL_IDS, ...GOOGLE_SLIDES_TOOL_IDS],
    builtins: CLI_WORKSPACE_BUILTINS,
    canCallAgents: ['researcher', 'browser_agent', 'android_agent', 'phone_agent'],
}
