import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import {
    GEMINI_API_KEY,
    GEMINI_CONTEXT_MESSAGES,
} from './config.js';
import { SYSTEM_PROMPT } from './prompt.js';
import { getAgentConfig } from './settings.js';

const THINKING_LEVEL_MAP = {
    MINIMAL: ThinkingLevel.MINIMAL,
    LOW: ThinkingLevel.LOW,
    MEDIUM: ThinkingLevel.MEDIUM,
    HIGH: ThinkingLevel.HIGH,
};

let cachedClient = null;

function mapThinkingLevel(level) {
    return THINKING_LEVEL_MAP[level] ?? ThinkingLevel.MINIMAL;
}

function normalizePart(part) {
    if (!part || typeof part !== 'object') {
        return null;
    }

    const normalized = {};

    if (typeof part.text === 'string') {
        normalized.text = part.text;
    }

    if (typeof part.thought === 'boolean') {
        normalized.thought = part.thought;
    }

    if (typeof part.thoughtSignature === 'string' && part.thoughtSignature.trim().length > 0) {
        normalized.thoughtSignature = part.thoughtSignature;
    }

    if (part.functionCall && typeof part.functionCall === 'object') {
        normalized.functionCall = part.functionCall;
    }

    if (part.functionResponse && typeof part.functionResponse === 'object') {
        normalized.functionResponse = part.functionResponse;
    }

    if (part.inlineData && typeof part.inlineData === 'object') {
        normalized.inlineData = part.inlineData;
    }

    if (part.fileData && typeof part.fileData === 'object') {
        normalized.fileData = part.fileData;
    }

    return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeParts(parts) {
    if (!Array.isArray(parts)) {
        return null;
    }

    const normalized = parts
        .map(normalizePart)
        .filter(Boolean);

    return normalized.length > 0 ? normalized : null;
}

function normalizeMessageParts(message) {
    const preservedParts = normalizeParts(message?.parts);
    if (preservedParts) {
        return preservedParts;
    }

    return [{ text: String(message?.text ?? '') }];
}

function normalizeHistory(messages) {
    return messages
        .filter((message) => message && (message.role === 'user' || message.role === 'ai'))
        .map((message) => ({
            role: message.role === 'ai' ? 'model' : 'user',
            parts: normalizeMessageParts(message),
        }));
}

function getClient() {
    if (!GEMINI_API_KEY) {
        throw new Error('Missing GEMINI_API_KEY or VITE_GEMINI_API_KEY in environment.');
    }

    if (!cachedClient) {
        cachedClient = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    }

    return cachedClient;
}

function createChatSession(historyWithLatestUserTurn) {
    if (!Array.isArray(historyWithLatestUserTurn) || historyWithLatestUserTurn.length === 0) {
        throw new Error('Cannot generate reply without a user message.');
    }

    const latest = historyWithLatestUserTurn[historyWithLatestUserTurn.length - 1];
    if (!latest || latest.role !== 'user') {
        throw new Error('Latest turn must be from user.');
    }

    const previousTurns = historyWithLatestUserTurn
        .slice(0, -1)
        .slice(-GEMINI_CONTEXT_MESSAGES);

    // Read model + thinking level dynamically from saved settings
    const agentConfig = getAgentConfig('orchestrator');

    const chat = getClient().chats.create({
        model: agentConfig.model,
        history: normalizeHistory(previousTurns),
        config: {
            systemInstruction: SYSTEM_PROMPT,
            thinkingConfig: {
                thinkingLevel: mapThinkingLevel(agentConfig.thinkingLevel),
                includeThoughts: true,
            },
        },
    });

    return {
        chat,
        latestText: String(latest.text ?? ''),
    };
}

function mergeChunkIntoText(previousText, chunkText) {
    const nextChunk = String(chunkText ?? '');
    if (!nextChunk) return previousText;

    if (nextChunk.startsWith(previousText)) {
        return nextChunk;
    }

    if (previousText.startsWith(nextChunk)) {
        return previousText;
    }

    return `${previousText}${nextChunk}`;
}

function finalizeText(value) {
    const text = String(value ?? '').trim();
    if (text) {
        return text;
    }

    return 'No text response was returned by Gemini.';
}

function finalizeThought(value) {
    return String(value ?? '').trim();
}

function extractChunkThoughtText(chunk) {
    const parts = chunk?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts) || parts.length === 0) {
        return '';
    }

    let thought = '';
    for (const part of parts) {
        if (part?.thought === true && typeof part.text === 'string') {
            thought += part.text;
        }
    }

    return thought;
}

function extractChunkThoughtSignatures(chunk) {
    const parts = chunk?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts) || parts.length === 0) {
        return [];
    }

    const signatures = [];
    for (const part of parts) {
        if (typeof part?.thoughtSignature === 'string' && part.thoughtSignature.trim().length > 0) {
            signatures.push(part.thoughtSignature);
        }
    }

    return signatures;
}

function extractChunkSignatureParts(chunk) {
    const parts = chunk?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts) || parts.length === 0) {
        return [];
    }

    const signatureParts = [];
    for (const part of parts) {
        if (typeof part?.thoughtSignature !== 'string' || part.thoughtSignature.trim().length === 0) {
            continue;
        }

        const normalized = normalizePart(part);
        if (normalized) {
            signatureParts.push(normalized);
        }
    }

    return signatureParts;
}

function extractChunkResponseText(chunk) {
    if (typeof chunk?.text === 'string' && chunk.text) {
        return chunk.text;
    }

    const parts = chunk?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts) || parts.length === 0) {
        return '';
    }

    let text = '';
    for (const part of parts) {
        if (part?.thought === true) {
            continue;
        }

        if (typeof part?.text === 'string') {
            text += part.text;
        }
    }

    return text;
}

function buildFinalModelParts({ text, thought, signatureParts }) {
    const parts = [];
    if (thought) {
        parts.push({
            text: thought,
            thought: true,
        });
    }

    if (text) {
        parts.push({ text });
    }

    for (const signaturePart of signatureParts) {
        parts.push(signaturePart);
    }

    return parts;
}

export async function generateAssistantReply(historyWithLatestUserTurn) {
    const { chat, latestText } = createChatSession(historyWithLatestUserTurn);

    const response = await chat.sendMessage({
        message: latestText,
    });

    return finalizeText(response?.text);
}

export async function generateAssistantReplyStream(historyWithLatestUserTurn, { onUpdate } = {}) {
    const { chat, latestText } = createChatSession(historyWithLatestUserTurn);
    const stream = await chat.sendMessageStream({
        message: latestText,
    });

    let fullText = '';
    let fullThought = '';
    let emittedText = '';
    let emittedThought = '';
    let emittedSignatureKey = '';
    const thoughtSignatureSet = new Set();
    const signaturePartsByKey = new Map();

    for await (const chunk of stream) {
        fullText = mergeChunkIntoText(fullText, extractChunkResponseText(chunk));
        fullThought = mergeChunkIntoText(fullThought, extractChunkThoughtText(chunk));
        for (const signature of extractChunkThoughtSignatures(chunk)) {
            thoughtSignatureSet.add(signature);
        }
        for (const signaturePart of extractChunkSignatureParts(chunk)) {
            if (typeof signaturePart.thoughtSignature !== 'string') {
                continue;
            }
            if (!signaturePartsByKey.has(signaturePart.thoughtSignature)) {
                signaturePartsByKey.set(signaturePart.thoughtSignature, signaturePart);
            }
        }

        const currentThoughtSignatures = [...thoughtSignatureSet];
        const currentSignatureKey = currentThoughtSignatures.join('|');
        const currentParts = buildFinalModelParts({
            text: fullText,
            thought: fullThought,
            signatureParts: [...signaturePartsByKey.values()],
        });

        const changed = (
            fullText !== emittedText
            || fullThought !== emittedThought
            || currentSignatureKey !== emittedSignatureKey
        );
        if (onUpdate && changed && (fullText || fullThought)) {
            emittedText = fullText;
            emittedThought = fullThought;
            emittedSignatureKey = currentSignatureKey;
            await onUpdate({
                text: fullText,
                thought: fullThought,
                parts: currentParts,
            });
        }
    }

    const finalText = finalizeText(fullText);
    const finalThought = finalizeThought(fullThought);
    const finalThoughtSignatures = [...thoughtSignatureSet];
    const finalSignatureKey = finalThoughtSignatures.join('|');
    const finalParts = buildFinalModelParts({
        text: finalText,
        thought: finalThought,
        signatureParts: [...signaturePartsByKey.values()],
    });

    if (
        onUpdate
        && (
            finalText !== emittedText
            || finalThought !== emittedThought
            || finalSignatureKey !== emittedSignatureKey
        )
    ) {
        await onUpdate({
            text: finalText,
            thought: finalThought,
            parts: finalParts,
        });
    }

    return {
        text: finalText,
        thought: finalThought,
        parts: finalParts,
    };
}

export async function listAvailableModels() {
    if (!GEMINI_API_KEY) {
        throw new Error('Missing GEMINI_API_KEY in environment.');
    }
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`);
    if (!res.ok) {
        throw new Error(`Failed to fetch models: ${res.status}`);
    }
    const data = await res.json();
    return data.models || [];
}
