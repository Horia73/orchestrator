import type { AgentConfig } from './types'

/**
 * Image generation agent. Codex ImageGen is the default subscription-backed
 * route; direct OpenAI API and Google image models remain selectable in
 * Settings and are never treated as silent fallbacks for one another.
 *
 * No buildPrompt: image agents don't take a free-form system prompt. The
 * chat route invokes provider.generateImage() directly with the user prompt.
 */
export const imageGenerator: AgentConfig = {
    id: 'image_generator',
    name: 'Image generator',
    description: 'Generates images from text prompts.',
    kind: 'image',
    provider: 'codex',
    model: 'imagegen',
    tools: [],
    canCallAgents: [],
}
