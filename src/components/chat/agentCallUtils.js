const AGENT_TOOL_METADATA = Object.freeze({
    generate_image: Object.freeze({
        agentId: 'image',
        agentName: 'Image Agent',  // matches imageAgent.name
    }),
    call_coding_agent: Object.freeze({
        agentId: 'coding',
        agentName: 'Coding Expert',
    }),
});

function safeJsonStringify(value) {
    try {
        return JSON.stringify(value ?? {});
    } catch {
        return '{}';
    }
}

export function getAgentToolMetadata(toolName) {
    const rawName = String(toolName ?? '').trim();
    if (!rawName) return null;
    return AGENT_TOOL_METADATA[rawName] ?? null;
}

export function getToolCallId(functionCall) {
    if (!functionCall || typeof functionCall !== 'object') {
        return '';
    }

    const explicitId = String(functionCall.id ?? '').trim();
    if (explicitId) return explicitId;

    const name = String(functionCall.name ?? '').trim() || 'unknown_tool';
    const argsKey = safeJsonStringify(functionCall.args ?? {});
    return `${name}:${argsKey}`;
}

export function findMatchingFunctionResponse(parts, functionCall, callIndex = -1) {
    const normalizedParts = Array.isArray(parts) ? parts : [];
    const callId = String(functionCall?.id ?? '').trim();
    const callName = String(functionCall?.name ?? '').trim();

    if (callId) {
        const matchById = normalizedParts.find((part) => {
            const response = part?.functionResponse;
            const responseId = String(response?.id ?? '').trim();
            return !!response && responseId === callId;
        });
        if (matchById?.functionResponse) {
            return matchById.functionResponse;
        }
    }

    if (callName) {
        const startIndex = Number.isInteger(callIndex) ? callIndex + 1 : 0;
        for (let index = startIndex; index < normalizedParts.length; index += 1) {
            const response = normalizedParts[index]?.functionResponse;
            if (!response) continue;
            const responseName = String(response?.name ?? '').trim();
            if (responseName === callName) {
                return response;
            }
        }

        for (const part of normalizedParts) {
            const response = part?.functionResponse;
            if (!response) continue;
            const responseName = String(response?.name ?? '').trim();
            if (responseName === callName) {
                return response;
            }
        }
    }

    return null;
}

function normalizeImageMimeType(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (!normalized || !normalized.includes('/')) {
        return 'application/octet-stream';
    }
    return normalized;
}

function getImageMediaPartKey(part) {
    const inlineData = part?.inlineData;
    if (inlineData && typeof inlineData === 'object') {
        const mimeType = normalizeImageMimeType(inlineData.mimeType ?? inlineData.mime_type);
        const data = String(inlineData.data ?? '').trim();
        if (mimeType.startsWith('image/') && data) {
            return `inline:${mimeType}:${data.length}:${data.slice(0, 48)}:${data.slice(-48)}`;
        }
    }

    const fileData = part?.fileData;
    if (fileData && typeof fileData === 'object') {
        const fileUri = String(fileData.fileUri ?? fileData.file_uri ?? '').trim();
        const mimeType = normalizeImageMimeType(fileData.mimeType ?? fileData.mime_type);
        if (mimeType.startsWith('image/') && fileUri) {
            return `file:${fileUri}`;
        }
    }

    return '';
}

function collectImageMediaParts(parts) {
    if (!Array.isArray(parts) || parts.length === 0) return [];

    const mediaParts = [];
    const seen = new Set();
    for (const part of parts) {
        const key = getImageMediaPartKey(part);
        if (!key || seen.has(key)) continue;
        seen.add(key);

        const inlineData = part?.inlineData;
        if (inlineData && typeof inlineData === 'object') {
            const mimeType = normalizeImageMimeType(inlineData.mimeType ?? inlineData.mime_type);
            const data = String(inlineData.data ?? '').trim();
            const displayName = String(inlineData.displayName ?? inlineData.display_name ?? '').trim();
            if (mimeType.startsWith('image/') && data) {
                mediaParts.push({
                    inlineData: {
                        mimeType,
                        data,
                        ...(displayName ? { displayName } : {}),
                    },
                });
                continue;
            }
        }

        const fileData = part?.fileData;
        if (fileData && typeof fileData === 'object') {
            const fileUri = String(fileData.fileUri ?? fileData.file_uri ?? '').trim();
            const mimeType = normalizeImageMimeType(fileData.mimeType ?? fileData.mime_type);
            const displayName = String(fileData.displayName ?? '').trim();
            if (mimeType.startsWith('image/') && fileUri) {
                mediaParts.push({
                    fileData: {
                        fileUri,
                        mimeType,
                        ...(displayName ? { displayName } : {}),
                    },
                });
            }
        }
    }
    return mediaParts;
}

function mergePartsWithImageMedia(parts, imageParts) {
    const baseParts = Array.isArray(parts) ? parts : [];
    const media = Array.isArray(imageParts) ? imageParts : [];
    if (baseParts.length === 0) return [...media];
    if (media.length === 0) return [...baseParts];

    const merged = [...baseParts];
    const seen = new Set();
    for (const part of baseParts) {
        const key = getImageMediaPartKey(part);
        if (key) seen.add(key);
    }

    for (const part of media) {
        const key = getImageMediaPartKey(part);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push(part);
    }
    return merged;
}

function getPartsContextsFromMessage(message) {
    if (!message || message.role !== 'ai') return [];

    const messageImageParts = collectImageMediaParts(message.parts);

    if (Array.isArray(message.steps) && message.steps.length > 0) {
        return message.steps
            .map((step, index) => ({
                stepIndex: index,
                text: String(step?.text ?? ''),
                thought: String(step?.thought ?? ''),
                parts: mergePartsWithImageMedia(step?.parts, messageImageParts),
            }))
            .filter((context) => context.parts.length > 0);
    }

    return [{
        stepIndex: -1,
        text: String(message.text ?? ''),
        thought: String(message.thought ?? ''),
        parts: mergePartsWithImageMedia(message.parts, messageImageParts),
    }];
}

export function findAgentToolCallInMessages(messages, callId) {
    const normalizedCallId = String(callId ?? '').trim();
    if (!normalizedCallId || !Array.isArray(messages) || messages.length === 0) return null;

    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        const contexts = getPartsContextsFromMessage(message);

        for (const context of contexts) {
            const contextParts = Array.isArray(context.parts) ? context.parts : [];
            for (let partIndex = 0; partIndex < contextParts.length; partIndex++) {
                const part = contextParts[partIndex];
                const functionCall = part?.functionCall;
                if (!functionCall) continue;

                if (getToolCallId(functionCall) !== normalizedCallId) continue;

                const agentMeta = getAgentToolMetadata(functionCall.name);
                if (!agentMeta) continue;

                const functionResponse = findMatchingFunctionResponse(contextParts, functionCall, partIndex);

                return {
                    callId: normalizedCallId,
                    toolName: String(functionCall.name),
                    agentId: agentMeta.agentId,
                    agentName: agentMeta.agentName,
                    sourceMessageId: String(message.id ?? ''),
                    context: {
                        text: context.text,
                        thought: context.thought,
                        parts: contextParts,
                    },
                    toolPart: {
                        functionCall,
                        functionResponse,
                        isExecuting: part?.isExecuting === true && !functionResponse,
                    },
                };
            }
        }
    }
    return null;
}

export function findLatestAgentToolCallInMessages(messages, toolName = '') {
    const preferredName = String(toolName ?? '').trim();
    if (!Array.isArray(messages) || messages.length === 0) return null;

    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        const contexts = getPartsContextsFromMessage(message);

        for (const context of contexts) {
            const contextParts = Array.isArray(context.parts) ? context.parts : [];
            for (let partIndex = contextParts.length - 1; partIndex >= 0; partIndex--) {
                const part = contextParts[partIndex];
                const functionCall = part?.functionCall;
                if (!functionCall) continue;

                const name = String(functionCall.name);
                if (preferredName && name !== preferredName) continue;

                const agentMeta = getAgentToolMetadata(name);
                if (!agentMeta) continue;

                const functionResponse = findMatchingFunctionResponse(contextParts, functionCall, partIndex);

                return {
                    callId: getToolCallId(functionCall),
                    toolName: name,
                    agentId: agentMeta.agentId,
                    agentName: agentMeta.agentName,
                    sourceMessageId: String(message.id ?? ''),
                    context: {
                        text: context.text,
                        thought: context.thought,
                        parts: contextParts,
                    },
                    toolPart: {
                        functionCall,
                        functionResponse,
                        isExecuting: part?.isExecuting === true && !functionResponse,
                    },
                };
            }
        }
    }
    return null;
}

export function buildAgentPanelMessage(agentCallDetails) {
    if (!agentCallDetails) return null;

    const functionResponse = agentCallDetails.toolPart?.functionResponse;
    const isExecuting = agentCallDetails.toolPart?.isExecuting === true;
    const resp = functionResponse?.response;

    const agentText = String(resp?.text ?? '').trim();
    const agentError = String(resp?.error ?? '').trim();
    const isThinking = (isExecuting && !functionResponse) || resp?.isThinking === true;
    const textFallback = isThinking ? 'Working...' : (Number(resp?.fileCount) > 0 ? `Analyzed ${resp.fileCount} file(s).` : '');

    const panelThought = String(resp?.agentThought ?? resp?.thought ?? '').trim();
    const panelText = agentError || agentText || textFallback;
    const respParts = Array.isArray(resp?.parts) ? resp.parts : [];
    const respSteps = Array.isArray(resp?.steps) ? resp.steps : [];

    const panelParts = [...respParts];

    return {
        role: 'ai',
        text: panelText,
        thought: panelThought,
        parts: panelParts,
        steps: respSteps,
        isThinking: (isExecuting && !functionResponse) || resp?.isThinking === true,
    };
}
