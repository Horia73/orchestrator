const IMAGE_AGENT_ID = 'image';

export const declaration = {
    name: 'generate_image',
    description: 'Generate or edit images by delegating to the Image agent.',
    parameters: {
        type: 'OBJECT',
        properties: {
            prompt: {
                type: 'STRING',
                description: 'Image generation/edit instruction.',
            },
            model: {
                type: 'STRING',
                description: 'Optional image-capable model override.',
            },
            aspectRatio: {
                type: 'STRING',
                description: 'Optional aspect ratio. Allowed values: 1:1, 1:4, 1:8, 2:3, 3:2, 3:4, 4:1, 4:3, 4:5, 5:4, 8:1, 9:16, 16:9, 21:9.',
            },
            imageSize: {
                type: 'STRING',
                description: 'Optional output size. Allowed values: 512px, 1K, 2K, 4K.',
            },
            waitForPreviousTools: {
                type: 'BOOLEAN',
                description: 'Optional scheduling hint. Ignored by local tool implementation.',
            },
        },
        required: ['prompt'],
    },
};

export async function execute({ prompt, model, aspectRatio, imageSize }) {
    const promptText = String(prompt ?? '').trim();
    if (!promptText) {
        return { error: 'prompt is required.' };
    }

    try {
        const { generateImageWithAgent } = await import('../../agents/image/service.js');
        const result = await generateImageWithAgent({ prompt: promptText, model, aspectRatio, imageSize });
        const usageMetadata = result.usageMetadata && typeof result.usageMetadata === 'object'
            ? result.usageMetadata
            : null;
        const outputSummary = result.text
            ? String(result.text).trim()
            : (result.imageCount > 0 ? `${result.imageCount} image(s) generated.` : '');

        return {
            ok: true,
            status: 'completed',
            model: result.model,
            prompt: promptText,
            text: result.text || '',
            agentThought: result.thought || '',
            imageCount: result.imageCount,
            generatedImages: result.mediaParts.map((part, index) => ({
                index: index + 1,
                mimeType: String(part?.inlineData?.mimeType ?? '').trim() || 'image/png',
                displayName: String(part?.inlineData?.displayName ?? '').trim() || `image-${index + 1}.png`,
            })),
            grounding: result.grounding,
            _mediaParts: result.mediaParts,
            _usageRecords: [{
                source: 'tool',
                toolName: 'generate_image',
                status: 'completed',
                agentId: IMAGE_AGENT_ID,
                model: result.model,
                inputText: promptText,
                outputText: outputSummary,
                usageMetadata,
            }],
        };
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error ?? 'Unknown image generation error.');
        return { status: 'error', error: `Failed to generate image: ${errorMessage}` };
    }
}
