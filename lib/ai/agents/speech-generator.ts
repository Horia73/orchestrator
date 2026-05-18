import type { AgentConfig } from './types'

/**
 * Speech (TTS) generation agent — Gemini 3.1 Flash TTS. Sync — returns audio
 * bytes directly. Leaf agent, no sub-agents.
 */
export const speechGenerator: AgentConfig = {
    id: 'speech_generator',
    name: 'Speech generator',
    description: 'Synthesises speech (TTS) from text.',
    kind: 'speech',
    provider: 'google',
    model: 'gemini-3.1-flash-tts-preview',
    tools: [],
    canCallAgents: [],
}
