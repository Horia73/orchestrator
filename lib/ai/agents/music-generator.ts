import type { AgentConfig } from './types'

/**
 * Music generation agent — Google Lyria 3 Pro. Lyria returns audio bytes plus
 * optional lyrics/structure text, so we model it sync alongside speech.
 */
export const musicGenerator: AgentConfig = {
    id: 'music_generator',
    name: 'Music generator',
    description: 'Generates music from text prompts.',
    kind: 'music',
    provider: 'google',
    model: 'lyria-3-pro-preview',
    tools: [],
    canCallAgents: [],
}
