import type { AgentConfig } from './types'

/**
 * Video generation agent — Google Veo 3.1. Async job model: runner starts
 * the job via provider.generateVideo() and polls via pollVideoJob(). No
 * sub-agents (leaf agent).
 */
export const videoGenerator: AgentConfig = {
    id: 'video_generator',
    name: 'Video generator',
    description: 'Generates short videos from text prompts.',
    kind: 'video',
    provider: 'google',
    model: 'veo-3.1-generate-preview',
    tools: [],
    canCallAgents: [],
}
