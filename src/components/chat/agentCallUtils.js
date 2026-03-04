const AGENT_TOOL_METADATA = Object.freeze({
    generate_image: Object.freeze({
        agentId: 'image',
        agentName: 'Image Agent',  // matches imageAgent.name
    }),
    call_browser_agent: Object.freeze({
        agentId: 'browser',
        agentName: 'Browser Agent',
    }),
    call_coding_agent: Object.freeze({
        agentId: 'coding',
        agentName: 'Coding Expert',
    }),
    call_multipurpose_agent: Object.freeze({
        agentId: 'multipurpose',
        agentName: 'Multipurpose Agent',
    }),
    call_researcher_agent: Object.freeze({
        agentId: 'researcher',
        agentName: 'Researcher Expert',
    }),
    spawn_subagent: Object.freeze({
        agentId: 'subagent',
        agentName: 'Subagent',
    }),
});

const SUBAGENT_RESULT_TOOL_NAME = 'spawn_subagent_result';

function formatAgentDisplayName(agentId, { isSubagent = false } = {}) {
    const normalizedAgentId = String(agentId ?? '').trim().toLowerCase();

    if (normalizedAgentId === 'coding') {
        return isSubagent ? 'Coding Subagent' : 'Coding Expert';
    }
    if (normalizedAgentId === 'browser') {
        return 'Browser Agent';
    }
    if (normalizedAgentId === 'researcher') {
        return isSubagent ? 'Researcher Subagent' : 'Researcher Expert';
    }
    if (normalizedAgentId === 'multipurpose') {
        return isSubagent ? 'Multipurpose Subagent' : 'Multipurpose Agent';
    }
    if (normalizedAgentId === 'image') {
        return 'Image Agent';
    }

    return isSubagent ? 'Subagent' : 'Agent';
}

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

        return null;
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

export function getAgentCallIdentity({ toolName, functionCall, functionResponse, callId } = {}) {
    const normalizedToolName = String(toolName ?? functionCall?.name ?? '').trim();
    const normalizedCallId = String(callId ?? getToolCallId(functionCall)).trim();
    const metadata = getAgentToolMetadata(normalizedToolName);
    const responseObject = functionResponse?.response ?? {};

    if (normalizedToolName === 'spawn_subagent') {
        const delegatedAgentId = String(
            responseObject?.agentId
            ?? functionCall?.args?.agentId
            ?? 'multipurpose',
        ).trim().toLowerCase() || 'multipurpose';
        const subagentId = String(responseObject?.subagentId ?? '').trim();
        const instanceId = subagentId || normalizedCallId;

        return {
            agentId: `subagent:${delegatedAgentId}`,
            agentName: formatAgentDisplayName(delegatedAgentId, { isSubagent: true }),
            instanceId,
            instanceLabel: subagentId || (normalizedCallId ? `call ${normalizedCallId}` : ''),
        };
    }

    const agentId = String(metadata?.agentId ?? '').trim();
    return {
        agentId,
        agentName: String(metadata?.agentName ?? '').trim() || formatAgentDisplayName(agentId),
        instanceId: normalizedCallId,
        instanceLabel: normalizedCallId,
    };
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

function getPartsContextsFromPayload(payload) {
    const messageImageParts = collectImageMediaParts(payload?.parts);

    if (Array.isArray(payload?.steps) && payload.steps.length > 0) {
        return payload.steps
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
        text: String(payload?.text ?? ''),
        thought: String(payload?.thought ?? ''),
        parts: mergePartsWithImageMedia(payload?.parts, messageImageParts),
    }];
}

function getNestedPayloadFromFunctionResponse(functionResponse) {
    const responseObject = functionResponse?.response;
    if (!responseObject || typeof responseObject !== 'object') {
        return null;
    }

    const parts = Array.isArray(responseObject.parts) ? responseObject.parts : [];
    const steps = Array.isArray(responseObject.steps) ? responseObject.steps : [];
    const text = String(responseObject.text ?? '').trim();
    const thought = String(responseObject.agentThought ?? responseObject.thought ?? '').trim();

    if (parts.length === 0 && steps.length === 0 && !text && !thought) {
        return null;
    }

    return {
        text,
        thought,
        parts,
        steps,
    };
}

function collectContextNodesFromPayload(payload, sourceMessageId, into, depth = 0) {
    if (!payload || depth > 12) {
        return;
    }

    const contexts = getPartsContextsFromPayload(payload);
    for (const context of contexts) {
        into.push({
            sourceMessageId,
            context,
        });

        const contextParts = Array.isArray(context.parts) ? context.parts : [];
        for (const part of contextParts) {
            const nestedPayload = getNestedPayloadFromFunctionResponse(part?.functionResponse);
            if (!nestedPayload) {
                continue;
            }
            collectContextNodesFromPayload(nestedPayload, sourceMessageId, into, depth + 1);
        }
    }
}

function getAllContextNodesFromMessage(message) {
    if (!message || message.role !== 'ai') {
        return [];
    }

    const nodes = [];
    collectContextNodesFromPayload({
        text: message.text,
        thought: message.thought,
        parts: message.parts,
        steps: message.steps,
    }, String(message.id ?? ''), nodes);
    return nodes;
}

export function findAgentToolCallInMessages(messages, callId) {
    const normalizedCallId = String(callId ?? '').trim();
    if (!normalizedCallId || !Array.isArray(messages) || messages.length === 0) return null;

    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        const contextNodes = getAllContextNodesFromMessage(message);

        for (const { sourceMessageId, context } of contextNodes) {
            const contextParts = Array.isArray(context.parts) ? context.parts : [];
            for (let partIndex = 0; partIndex < contextParts.length; partIndex++) {
                const part = contextParts[partIndex];
                const functionCall = part?.functionCall;
                if (!functionCall) continue;

                if (getToolCallId(functionCall) !== normalizedCallId) continue;

                const agentMeta = getAgentToolMetadata(functionCall.name);
                if (!agentMeta) continue;

                const functionResponse = findMatchingFunctionResponse(contextParts, functionCall, partIndex);
                const identity = getAgentCallIdentity({
                    toolName: functionCall.name,
                    functionCall,
                    functionResponse,
                    callId: normalizedCallId,
                });

                return {
                    callId: normalizedCallId,
                    toolName: String(functionCall.name),
                    agentId: identity.agentId,
                    agentName: identity.agentName,
                    instanceId: identity.instanceId,
                    instanceLabel: identity.instanceLabel,
                    sourceMessageId,
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
        const contextNodes = getAllContextNodesFromMessage(message);

        for (const { sourceMessageId, context } of contextNodes) {
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
                const identity = getAgentCallIdentity({
                    toolName: name,
                    functionCall,
                    functionResponse,
                    callId: getToolCallId(functionCall),
                });

                return {
                    callId: getToolCallId(functionCall),
                    toolName: name,
                    agentId: identity.agentId,
                    agentName: identity.agentName,
                    instanceId: identity.instanceId,
                    instanceLabel: identity.instanceLabel,
                    sourceMessageId,
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

function getFunctionResponsesFromParts(parts) {
    if (!Array.isArray(parts) || parts.length === 0) {
        return [];
    }

    return parts
        .map((part) => part?.functionResponse)
        .filter(Boolean);
}

function collectFunctionResponsesFromPayload(payload, into, depth = 0) {
    if (!payload || depth > 12) {
        return;
    }

    const contexts = getPartsContextsFromPayload(payload);
    for (const context of contexts) {
        const contextParts = Array.isArray(context.parts) ? context.parts : [];
        for (const functionResponse of getFunctionResponsesFromParts(contextParts)) {
            into.push(functionResponse);
            const nestedPayload = getNestedPayloadFromFunctionResponse(functionResponse);
            if (nestedPayload) {
                collectFunctionResponsesFromPayload(nestedPayload, into, depth + 1);
            }
        }
    }
}

export function findSubagentResultInMessages(messages, { callId, subagentId } = {}) {
    const normalizedCallId = String(callId ?? '').trim();
    const normalizedSubagentId = String(subagentId ?? '').trim();
    if (!Array.isArray(messages) || messages.length === 0) {
        return null;
    }

    for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i];
        const responseParts = [];
        collectFunctionResponsesFromPayload({
            text: message?.text,
            thought: message?.thought,
            parts: message?.parts,
            steps: message?.steps,
        }, responseParts);

        for (const functionResponse of responseParts) {
            const responseName = String(functionResponse?.name ?? '').trim();
            if (responseName !== SUBAGENT_RESULT_TOOL_NAME) {
                continue;
            }

            const responseObject = functionResponse?.response ?? {};
            const responseCallId = String(responseObject?.parentToolCallId ?? '').trim();
            const responseSubagentId = String(
                responseObject?.subagentId
                ?? functionResponse?.id
                ?? '',
            ).trim();

            if (normalizedCallId && responseCallId === normalizedCallId) {
                return {
                    message,
                    functionResponse,
                };
            }

            if (normalizedSubagentId && responseSubagentId === normalizedSubagentId) {
                return {
                    message,
                    functionResponse,
                };
            }
        }
    }

    return null;
}

function hasRenderableAgentResult(responseObject) {
    if (!responseObject || typeof responseObject !== 'object') {
        return false;
    }

    const text = String(responseObject.text ?? '').trim();
    const thought = String(responseObject.agentThought ?? responseObject.thought ?? '').trim();
    const hasParts = Array.isArray(responseObject.parts) && responseObject.parts.length > 0;
    const hasSteps = Array.isArray(responseObject.steps) && responseObject.steps.length > 0;
    const error = String(responseObject.error ?? '').trim();

    return Boolean(text || thought || hasParts || hasSteps || error);
}

function getPrimaryThinkingDurationMs(responseObject) {
    if (!responseObject || typeof responseObject !== 'object') {
        return 0;
    }

    const directDurationMs = Number(responseObject.thinkingDurationMs);
    if (Number.isFinite(directDurationMs) && directDurationMs > 0) {
        return directDurationMs;
    }

    const steps = Array.isArray(responseObject.steps) ? responseObject.steps : [];
    for (const step of steps) {
        const durationMs = Number(step?.thinkingDurationMs);
        if (Number.isFinite(durationMs) && durationMs > 0) {
            return durationMs;
        }
    }

    return 0;
}

export function buildAgentPanelMessage(agentCallDetails, messages = []) {
    if (!agentCallDetails) return null;

    const functionResponse = agentCallDetails.toolPart?.functionResponse;
    const isExecuting = agentCallDetails.toolPart?.isExecuting === true;
    let resp = functionResponse?.response;

    if (String(agentCallDetails?.toolName ?? '').trim() === 'spawn_subagent') {
        const resolvedSubagentId = String(
            resp?.subagentId
            ?? agentCallDetails?.instanceId
            ?? '',
        ).trim();
        if (!hasRenderableAgentResult(resp)) {
            const subagentResult = findSubagentResultInMessages(messages, {
                callId: agentCallDetails?.callId,
                subagentId: resolvedSubagentId,
            });
            if (subagentResult?.functionResponse?.response) {
                resp = subagentResult.functionResponse.response;
            }
        }
    }

    const agentText = String(resp?.text ?? '').trim();
    const agentError = String(resp?.error ?? '').trim();
    const rawStatus = String(resp?.status ?? '').trim().toLowerCase();
    const isThinking = (
        (isExecuting && !functionResponse)
        || resp?.isThinking === true
        || rawStatus === 'thinking'
        || rawStatus === 'running'
        || rawStatus === 'working'
        || rawStatus === 'spawned'
        || rawStatus === 'queued'
    );
    const textFallback = isThinking
        ? 'Working...'
        : (Number(resp?.fileCount) > 0 ? `Analyzed ${resp.fileCount} file(s).` : '');

    const panelThought = String(resp?.agentThought ?? resp?.thought ?? '').trim();
    const queuedText = String(resp?.message ?? '').trim();
    const panelText = agentError || agentText || queuedText || textFallback;
    const respParts = (Array.isArray(resp?.parts) && resp.parts.length > 0)
        ? resp.parts
        : (Array.isArray(resp?._mediaParts) ? resp._mediaParts : []);
    const respSteps = Array.isArray(resp?.steps) ? resp.steps : [];

    const panelParts = [...respParts];

    return {
        role: 'ai',
        text: panelText,
        thought: panelThought,
        parts: panelParts,
        steps: respSteps,
        thinkingDurationMs: getPrimaryThinkingDurationMs(resp),
        isThinking,
    };
}
