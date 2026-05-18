import type { AgentConfig } from './types'

/**
 * Image generation agent. The user picks the active model in Settings. GPT
 * Image 2 (OpenAI) and Nano Banana 2 (Google) are first-class routes; neither
 * provider is treated as a fallback for the other.
 *
 * No buildPrompt: image agents don't take a free-form system prompt. The
 * chat route invokes provider.generateImage() directly with the user prompt.
 */
export const imageGenerator: AgentConfig = {
    id: 'image_generator',
    name: 'Image generator',
    description: 'Generates images from text prompts.',
    kind: 'image',
    provider: 'openai',
    model: 'gpt-image-2',
    tools: [],
    canCallAgents: [],
}
