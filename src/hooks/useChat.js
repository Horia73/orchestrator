import { useState, useRef, useMemo, useEffect, useCallback } from 'react';
import {
    deleteChat as apiDeleteChat,
    fetchChatMessages,
    fetchChats,
    fetchStreamingState,
    openChatEvents,
    stopChatGeneration,
    sendChatMessage,
} from '../api/chatApi.js';
import { getAgentToolMetadata, getToolCallId } from '../components/chat/agentCallUtils.js';

const CLIENT_ID_STORAGE_KEY = 'gemini-ui-client-id';
const ACTIVE_CHAT_STORAGE_KEY = 'gemini-ui-active-chat-id';
const DRAFT_AGENT_STORAGE_KEY = 'gemini-ui-draft-agent-id';
const DEFAULT_AGENT_ID = 'orchestrator';
const DRAFT_CHAT_KEY = '__draft__';
const INBOX_CHAT_KIND = 'inbox';

function getGreeting() {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 17) return 'Good afternoon';
    return 'Good evening';
}

function createId(prefix) {
    if (globalThis.crypto?.randomUUID) {
        return `${prefix}-${globalThis.crypto.randomUUID()}`;
    }

    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getOrCreateClientId() {
    try {
        const existing = localStorage.getItem(CLIENT_ID_STORAGE_KEY);
        if (existing) return existing;

        const created = createId('client');
        localStorage.setItem(CLIENT_ID_STORAGE_KEY, created);
        return created;
    } catch {
        return createId('client');
    }
}

function getStoredActiveChatId() {
    try {
        const stored = localStorage.getItem(ACTIVE_CHAT_STORAGE_KEY);
        if (!stored) return null;
        const normalized = String(stored).trim();
        return normalized || null;
    } catch {
        return null;
    }
}

function getStoredDraftAgentId() {
    try {
        const stored = localStorage.getItem(DRAFT_AGENT_STORAGE_KEY);
        if (stored) return String(stored).trim() || DEFAULT_AGENT_ID;
    } catch {
        // ignore
    }

    return DEFAULT_AGENT_ID;
}

function sortChatsByRecent(chats) {
    return [...chats].sort((a, b) => {
        const pinnedDiff = Number(Boolean(b?.pinned)) - Number(Boolean(a?.pinned));
        if (pinnedDiff !== 0) {
            return pinnedDiff;
        }

        return b.updatedAt - a.updatedAt;
    });
}

function getDraftKey(chatId) {
    return (chatId === null || chatId === undefined) ? DRAFT_CHAT_KEY : String(chatId);
}

function isInboxChat(chat) {
    return String(chat?.kind ?? '').trim().toLowerCase() === INBOX_CHAT_KIND;
}

function pickDefaultActiveChatId(chats, { preferredId, allowInboxFallback = false } = {}) {
    const normalizedChats = Array.isArray(chats) ? chats : [];
    if (preferredId) {
        const preferred = normalizedChats.find((chat) => chat.id === preferredId);
        if (preferred) {
            return preferred.id;
        }
    }

    const firstRegularChat = normalizedChats.find((chat) => !isInboxChat(chat));
    if (firstRegularChat) {
        return firstRegularChat.id;
    }

    if (allowInboxFallback) {
        return normalizedChats[0]?.id ?? null;
    }

    return null;
}

function truncateReplyPreview(text, maxLength = 160) {
    const normalized = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!normalized) {
        return '';
    }

    if (normalized.length <= maxLength) {
        return normalized;
    }

    return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function buildReplyPreviewText(message) {
    const directText = truncateReplyPreview(message?.text, 160);
    if (directText) {
        return directText;
    }

    const stepPreview = Array.isArray(message?.steps)
        ? truncateReplyPreview(
            message.steps
                .map((step) => String(step?.text ?? '').trim() || String(step?.thought ?? '').trim())
                .filter(Boolean)
                .join(' '),
            160,
        )
        : '';
    if (stepPreview) {
        return stepPreview;
    }

    const hasAttachment = Array.isArray(message?.parts)
        && message.parts.some((part) => part?.fileData || part?.inlineData);
    if (hasAttachment) {
        return 'Attachment';
    }

    return 'Message';
}

function mergeMessages(existing, incoming) {
    const byId = new Map();

    for (const message of existing) {
        if (message) byId.set(message.id, message);
    }

    for (const message of incoming) {
        if (message) byId.set(message.id, message);
    }

    return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
}

function toErrorMessage(error) {
    if (error instanceof Error && error.message) {
        return `AI error: ${error.message}`;
    }

    return 'AI error: Request failed.';
}

function normalizeAttachmentMimeType(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (!normalized || !normalized.includes('/')) {
        return 'application/octet-stream';
    }

    return normalized;
}

function normalizeAttachmentSize(value) {
    const normalized = Number(value);
    return Number.isFinite(normalized) && normalized > 0 ? Math.trunc(normalized) : 0;
}

function normalizeDraftAttachments(attachments) {
    if (!Array.isArray(attachments)) {
        return [];
    }

    return attachments
        .map((attachment, index) => {
            if (!attachment || typeof attachment !== 'object') {
                return null;
            }

            const id = String(attachment.id ?? `att-${index + 1}`).trim() || `att-${index + 1}`;
            const name = String(attachment.name ?? `attachment-${index + 1}`).trim() || `attachment-${index + 1}`;
            const mimeType = normalizeAttachmentMimeType(attachment.mimeType ?? attachment.type);
            const uploadId = String(attachment.uploadId ?? '').trim();
            const fileUri = String(attachment.fileUri ?? '').trim();
            const previewUrl = String(attachment.previewUrl ?? '').trim();
            const status = String(attachment.status ?? '').trim().toLowerCase() || 'ready';
            const size = normalizeAttachmentSize(attachment.size ?? attachment.sizeBytes);

            if ((!uploadId || !fileUri) && status !== 'uploading') {
                return null;
            }

            return {
                id,
                uploadId,
                name,
                mimeType,
                size,
                fileUri,
                previewUrl,
                status,
            };
        })
        .filter(Boolean);
}

function serializeOutgoingAttachments(attachments) {
    return normalizeDraftAttachments(attachments)
        .filter((attachment) => attachment.status !== 'uploading' && attachment.uploadId && attachment.fileUri)
        .map((attachment) => ({
            uploadId: attachment.uploadId,
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.size,
        }));
}

function buildUserMessageParts(text, attachments) {
    const normalizedText = String(text ?? '').trim();
    const normalizedAttachments = normalizeDraftAttachments(attachments)
        .filter((attachment) => attachment.status !== 'uploading' && attachment.uploadId && attachment.fileUri);
    const parts = normalizedAttachments.map((attachment) => ({
        fileData: {
            uploadId: attachment.uploadId,
            fileUri: attachment.fileUri,
            mimeType: attachment.mimeType,
            displayName: attachment.name,
            sizeBytes: attachment.size,
        },
    }));

    if (normalizedText) {
        parts.push({ text: normalizedText });
    }

    return parts.length > 0 ? parts : null;
}

function getAgentStreamingKey(toolCallId, toolName) {
    const normalizedCallId = String(toolCallId ?? '').trim();
    if (normalizedCallId) {
        return normalizedCallId;
    }

    return String(toolName ?? '').trim();
}

function isCompletedStreamState(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    return normalized === 'complete' || normalized === 'completed' || normalized === 'done';
}

function collectAgentStreamingKeysFromParts(parts, into) {
    if (!Array.isArray(parts)) {
        return;
    }

    const responseIds = new Set();
    const responseNames = new Set();
    for (const part of parts) {
        const functionResponse = part?.functionResponse;
        if (!functionResponse) {
            continue;
        }

        const responseId = String(functionResponse.id ?? '').trim();
        const responseName = String(functionResponse.name ?? '').trim();
        if (responseId) {
            responseIds.add(responseId);
        }
        if (responseName) {
            responseNames.add(responseName);
        }
    }

    for (const part of parts) {
        const functionCall = part?.functionCall;
        if (!functionCall || !getAgentToolMetadata(functionCall.name)) {
            const functionResponse = part?.functionResponse;
            const responseName = String(functionResponse?.name ?? '').trim();
            if (responseName === 'spawn_subagent_result') {
                const parentToolCallId = String(
                    functionResponse?.response?.parentToolCallId ?? '',
                ).trim();
                if (parentToolCallId) {
                    into.add(parentToolCallId);
                }
            }
            continue;
        }

        const callId = getToolCallId(functionCall);
        const callName = String(functionCall.name ?? '').trim();
        const hasCompletion = callId
            ? responseIds.has(callId)
            : responseNames.has(callName);
        if (!hasCompletion) {
            continue;
        }

        const key = getAgentStreamingKey(
            callId,
            callName,
        );
        if (key) {
            into.add(key);
        }
    }
}

function collectAgentStreamingKeysFromMessage(message) {
    const keys = new Set();
    if (!message || typeof message !== 'object') {
        return keys;
    }

    collectAgentStreamingKeysFromParts(message.parts, keys);
    if (Array.isArray(message.steps)) {
        for (const step of message.steps) {
            collectAgentStreamingKeysFromParts(step?.parts, keys);
        }
    }

    return keys;
}

function normalizeSendPayload(payload) {
    if (typeof payload === 'string') {
        return {
            text: payload,
            attachments: [],
        };
    }

    if (!payload || typeof payload !== 'object') {
        return {
            text: '',
            attachments: [],
        };
    }

    return {
        text: String(payload.text ?? ''),
        attachments: normalizeDraftAttachments(payload.attachments),
    };
}

function createLocalMessage(id, role, text, options = {}) {
    const message = {
        id,
        role,
        text,
        createdAt: Date.now(),
    };

    const normalizedParts = Array.isArray(options.parts) && options.parts.length > 0
        ? options.parts
        : null;
    if (normalizedParts) {
        message.parts = normalizedParts;
    }

    if (options.replyTo && typeof options.replyTo === 'object') {
        message.replyTo = options.replyTo;
    }

    return message;
}

function upsertChatSummary(chats, summary) {
    const idx = chats.findIndex((chat) => chat.id === summary.id);
    if (idx === -1) {
        return sortChatsByRecent([summary, ...chats]);
    }

    const next = [...chats];
    next[idx] = summary;
    return sortChatsByRecent(next);
}

function messageHasVisibleContent(message) {
    if (!message || typeof message !== 'object') {
        return false;
    }

    if (String(message.text ?? '').trim()) {
        return true;
    }

    if (String(message.thought ?? '').trim()) {
        return true;
    }

    if (Array.isArray(message.parts) && message.parts.length > 0) {
        return true;
    }

    return Array.isArray(message.steps) && message.steps.length > 0;
}

function hasAssistantReplyAfterLatestUser(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
        return false;
    }

    let latestUserIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === 'user') {
            latestUserIndex = index;
            break;
        }
    }

    const startIndex = latestUserIndex === -1 ? 0 : latestUserIndex + 1;
    for (let index = messages.length - 1; index >= startIndex; index -= 1) {
        const message = messages[index];
        if (message?.role !== 'ai') {
            continue;
        }

        if (messageHasVisibleContent(message)) {
            return true;
        }
    }

    return false;
}

function clearAgentStreamingForMessages(currentAgentStreaming, messages) {
    if (!currentAgentStreaming || typeof currentAgentStreaming !== 'object') {
        return currentAgentStreaming;
    }

    const keys = new Set();
    for (const message of messages) {
        const messageKeys = collectAgentStreamingKeysFromMessage(message);
        for (const key of messageKeys) {
            keys.add(key);
        }
    }

    if (keys.size === 0) {
        return currentAgentStreaming;
    }

    let changed = false;
    const next = { ...currentAgentStreaming };
    for (const key of keys) {
        if (!(key in next)) {
            continue;
        }

        delete next[key];
        changed = true;
    }

    return changed ? next : currentAgentStreaming;
}

export function useChat() {
    const [chatSummaries, setChatSummaries] = useState([]);
    const [messagesByChat, setMessagesByChat] = useState({});
    const [activeChatId, setActiveChatId] = useState(undefined);
    const [draftMessages, setDraftMessages] = useState([]);
    const [draftReplyContext, setDraftReplyContext] = useState(null);
    const [inputDraftByKey, setInputDraftByKey] = useState({});
    const [inputAttachmentsByKey, setInputAttachmentsByKey] = useState({});
    const [pendingKey, setPendingKey] = useState(null);
    const [draftAgentId, setDraftAgentIdState] = useState(() => getStoredDraftAgentId());
    const [isHydrating, setIsHydrating] = useState(true);
    const [agentStreaming, setAgentStreaming] = useState({});
    const [commandChunks, setCommandChunks] = useState({});
    const [readCounts, setReadCounts] = useState(() => {
        try {
            return JSON.parse(localStorage.getItem('gemini-ui-read-counts')) || {};
        } catch {
            return {};
        }
    });

    const clientIdRef = useRef(getOrCreateClientId());
    const chatSummariesRef = useRef(chatSummaries);
    const messagesByChatRef = useRef(messagesByChat);
    const activeChatIdRef = useRef(activeChatId);
    const draftMessagesRef = useRef(draftMessages);
    const draftReplyContextRef = useRef(draftReplyContext);
    const pendingKeyRef = useRef(pendingKey);
    const loadedChatIdsRef = useRef(new Set());
    const preferredActiveChatIdRef = useRef(getStoredActiveChatId());
    const draftAgentIdRef = useRef(draftAgentId);
    const chatAgentByIdRef = useRef(new Map());
    const pendingDraftChatIdRef = useRef(null);

    useEffect(() => {
        chatSummariesRef.current = chatSummaries;
    }, [chatSummaries]);

    useEffect(() => {
        messagesByChatRef.current = messagesByChat;
    }, [messagesByChat]);

    useEffect(() => {
        activeChatIdRef.current = activeChatId;
    }, [activeChatId]);

    useEffect(() => {
        draftMessagesRef.current = draftMessages;
    }, [draftMessages]);

    useEffect(() => {
        draftReplyContextRef.current = draftReplyContext;
    }, [draftReplyContext]);

    useEffect(() => {
        pendingKeyRef.current = pendingKey;
    }, [pendingKey]);

    useEffect(() => {
        draftAgentIdRef.current = draftAgentId;
        try {
            localStorage.setItem(DRAFT_AGENT_STORAGE_KEY, draftAgentId);
        } catch {
            // noop
        }
    }, [draftAgentId]);

    useEffect(() => {
        const nextMap = new Map();
        for (const chat of chatSummaries) {
            const chatId = String(chat?.id ?? '').trim();
            if (!chatId) continue;
            const agentId = String(chat?.agentId ?? '').trim() || DEFAULT_AGENT_ID;
            nextMap.set(chatId, agentId);
        }
        chatAgentByIdRef.current = nextMap;
    }, [chatSummaries]);

    useEffect(() => {
        if (!activeChatId) return;
        const activeSummary = chatSummariesRef.current.find((c) => c.id === activeChatId);
        if (activeSummary) {
            setReadCounts((prev) => {
                const prevCount = prev[activeChatId] || 0;
                const count = activeSummary.messageCount || 0;
                if (prevCount >= count) return prev;
                const next = { ...prev, [activeChatId]: count };
                try {
                    localStorage.setItem('gemini-ui-read-counts', JSON.stringify(next));
                } catch {
                    // ignore
                }
                return next;
            });
        }
    }, [activeChatId, chatSummaries]);

    useEffect(() => {
        if (activeChatId === undefined) return;

        try {
            if (typeof activeChatId === 'string' && activeChatId.length > 0) {
                localStorage.setItem(ACTIVE_CHAT_STORAGE_KEY, activeChatId);
                preferredActiveChatIdRef.current = activeChatId;
                return;
            }

            localStorage.removeItem(ACTIVE_CHAT_STORAGE_KEY);
            preferredActiveChatIdRef.current = null;
        } catch {
            // noop
        }
    }, [activeChatId]);

    const refreshChats = useCallback(async () => {
        try {
            const payload = await fetchChats();
            const nextChats = sortChatsByRecent(payload.chats ?? []);
            setChatSummaries(nextChats);

            setActiveChatId((current) => {
                if (current === undefined) {
                    if (preferredActiveChatIdRef.current === null) {
                        return null;
                    }
                    return pickDefaultActiveChatId(nextChats, {
                        preferredId: preferredActiveChatIdRef.current,
                    });
                }

                if (current === null) {
                    return null;
                }

                const exists = nextChats.some((chat) => chat.id === current);
                return exists
                    ? current
                    : pickDefaultActiveChatId(nextChats, {
                        preferredId: preferredActiveChatIdRef.current,
                    });
            });
        } finally {
            setIsHydrating(false);
        }
    }, []);

    const loadMessagesForChat = useCallback(async (chatId) => {
        if (!chatId || loadedChatIdsRef.current.has(chatId)) return;

        const payload = await fetchChatMessages(chatId);
        loadedChatIdsRef.current.add(chatId);

        // Recover in-flight streaming state if the server is still generating.
        let streamingMessage = null;
        let recoveredAgentStreaming = null;
        try {
            const streamState = await fetchStreamingState(chatId);
            if (streamState.active && streamState.message) {
                streamingMessage = streamState.message;
                if (streamState.agentStreaming && Object.keys(streamState.agentStreaming).length > 0) {
                    recoveredAgentStreaming = streamState.agentStreaming;
                }
            }
        } catch {
            // Ignore - streaming state recovery is best-effort.
        }

        setMessagesByChat((prev) => {
            const messages = payload.messages ?? [];
            if (streamingMessage) {
                return {
                    ...prev,
                    [chatId]: mergeMessages(messages, [streamingMessage]),
                };
            }
            return {
                ...prev,
                [chatId]: messages,
            };
        });

        if (streamingMessage) {
            setPendingKey(chatId);
        }
        if (recoveredAgentStreaming) {
            setAgentStreaming((prev) => ({ ...prev, ...recoveredAgentStreaming }));
        }
    }, []);

    useEffect(() => {
        refreshChats().catch(() => undefined);
    }, [refreshChats]);

    useEffect(() => {
        if (!activeChatId) return;
        loadMessagesForChat(activeChatId).catch(() => undefined);
    }, [activeChatId, loadMessagesForChat]);

    useEffect(() => {
        const pendingChatId = (
            typeof pendingKey === 'string'
            && pendingKey.length > 0
            && pendingKey !== 'draft'
            && pendingKey === activeChatId
        )
            ? pendingKey
            : null;
        if (!pendingChatId) {
            return undefined;
        }

        let cancelled = false;
        let timeoutId = null;

        const scheduleNextPoll = (delayMs = 2500) => {
            if (cancelled) {
                return;
            }

            timeoutId = setTimeout(() => {
                void reconcileStreamingState();
            }, delayMs);
        };

        // Recover if the SSE completion event is missed while the request is still in-flight.
        const reconcileStreamingState = async () => {
            try {
                const streamState = await fetchStreamingState(pendingChatId);
                if (cancelled) {
                    return;
                }

                if (streamState.active) {
                    if (streamState.message) {
                        setMessagesByChat((prev) => ({
                            ...prev,
                            [pendingChatId]: mergeMessages(prev[pendingChatId] ?? [], [streamState.message]),
                        }));
                    }

                    if (streamState.agentStreaming && Object.keys(streamState.agentStreaming).length > 0) {
                        setAgentStreaming((prev) => ({ ...prev, ...streamState.agentStreaming }));
                    }

                    scheduleNextPoll();
                    return;
                }

                const payload = await fetchChatMessages(pendingChatId);
                if (cancelled) {
                    return;
                }

                const refreshedMessages = payload.messages ?? [];
                const currentMessages = messagesByChatRef.current[pendingChatId] ?? [];
                const shouldResolvePending = hasAssistantReplyAfterLatestUser(refreshedMessages)
                    || hasAssistantReplyAfterLatestUser(currentMessages);
                const messagesForCleanup = refreshedMessages.length > 0
                    ? refreshedMessages
                    : currentMessages;

                if (!shouldResolvePending) {
                    scheduleNextPoll(1200);
                    return;
                }

                loadedChatIdsRef.current.add(pendingChatId);
                setMessagesByChat((prev) => ({
                    ...prev,
                    [pendingChatId]: mergeMessages(prev[pendingChatId] ?? [], refreshedMessages),
                }));
                setAgentStreaming((prev) => clearAgentStreamingForMessages(prev, messagesForCleanup));
                setPendingKey((current) => (current === pendingChatId ? null : current));
            } catch {
                if (cancelled) {
                    return;
                }

                scheduleNextPoll();
            }
        };

        scheduleNextPoll();

        return () => {
            cancelled = true;
            if (timeoutId !== null) {
                clearTimeout(timeoutId);
            }
        };
    }, [activeChatId, pendingKey]);

    useEffect(() => {
        const source = openChatEvents((event) => {
            const isOwnEvent = event.originClientId === clientIdRef.current;

            if (event.type === 'chat.upsert' && event.chat) {
                // Include own upserts so a brand-new chat appears in Recents
                // immediately after pressing Enter on the first message.
                setChatSummaries((prev) => upsertChatSummary(prev, event.chat));
                const nextChatId = String(event.chat?.id ?? '').trim();
                if (
                    isOwnEvent
                    && nextChatId
                    && (activeChatIdRef.current === null || activeChatIdRef.current === undefined)
                    && pendingKeyRef.current === 'draft'
                ) {
                    pendingDraftChatIdRef.current = nextChatId;
                    setMessagesByChat((prev) => ({
                        ...prev,
                        [nextChatId]: mergeMessages(prev[nextChatId] ?? [], draftMessagesRef.current),
                    }));
                    setDraftMessages([]);
                    setActiveChatId(nextChatId);
                    setPendingKey(nextChatId);
                }
                return;
            }

            if (event.type === 'message.streaming' && event.chatId && event.message) {
                const isCompletedStream = isCompletedStreamState(event.streamState);
                const pendingDraftChatId = pendingDraftChatIdRef.current;
                if (
                    isOwnEvent
                    && pendingDraftChatId
                    && event.chatId === pendingDraftChatId
                ) {
                    setPendingKey(event.chatId);
                    setActiveChatId((current) => current ?? event.chatId);
                    setMessagesByChat((prev) => ({
                        ...prev,
                        [event.chatId]: mergeMessages(prev[event.chatId] ?? [], [event.message]),
                    }));
                    return;
                }

                if (isOwnEvent && (activeChatIdRef.current === null || activeChatIdRef.current === undefined)) {
                    setPendingKey('draft');
                    setDraftMessages((prev) => mergeMessages(prev, [event.message]));
                    return;
                }

                if (activeChatIdRef.current === event.chatId) {
                    setPendingKey(event.chatId);
                }

                setMessagesByChat((prev) => {
                    const shouldTrackMessage = isOwnEvent
                        || (event.chatId in prev)
                        || activeChatIdRef.current === event.chatId;

                    if (!shouldTrackMessage) {
                        return prev;
                    }

                    const existingMessages = prev[event.chatId] ?? [];
                    const incomingMessage = event.message;
                    const existingMessage = existingMessages.find(m => m.id === incomingMessage.id);

                    if (existingMessage && Array.isArray(existingMessage.parts) && Array.isArray(incomingMessage.parts)) {
                        // Preserve sub-agent streaming progress if incoming message hasn't caught up yet.
                        // Collect all synthetic agent responses from existing message (parts + steps).
                        const syntheticResponses = [];
                        const collectSynthetic = (parts) => {
                            if (!Array.isArray(parts)) return;
                            for (const p of parts) {
                                if (p.functionResponse) {
                                    syntheticResponses.push(p);
                                }
                            }
                        };
                        collectSynthetic(existingMessage.parts);
                        if (Array.isArray(existingMessage.steps)) {
                            for (const step of existingMessage.steps) {
                                collectSynthetic(step?.parts);
                            }
                        }

                        // Re-inject missing responses into incoming parts.
                        const preserveInParts = (targetParts) => {
                            if (!Array.isArray(targetParts)) return targetParts;
                            const result = [...targetParts];
                            for (const existing of syntheticResponses) {
                                const toolId = existing.functionResponse.id;
                                const toolName = existing.functionResponse.name;
                                const hasToolId = typeof toolId === 'string' && toolId.trim().length > 0;
                                const alreadyPresent = result.some(p =>
                                    p.functionResponse && (
                                        hasToolId
                                            ? p.functionResponse.id === toolId
                                            : p.functionResponse.name === toolName
                                    )
                                );
                                if (!alreadyPresent) {
                                    const callIndex = result.findIndex(p =>
                                        p.functionCall && (
                                            hasToolId
                                                ? p.functionCall.id === toolId
                                                : p.functionCall.name === toolName
                                        )
                                    );
                                    if (callIndex !== -1) {
                                        result.splice(callIndex + 1, 0, existing);
                                    }
                                }
                            }
                            return result;
                        };

                        incomingMessage.parts = preserveInParts(incomingMessage.parts);

                        if (Array.isArray(incomingMessage.steps) && syntheticResponses.length > 0) {
                            incomingMessage.steps = incomingMessage.steps.map(step => {
                                if (!Array.isArray(step?.parts) || step.parts.length === 0) return step;
                                const preserved = preserveInParts(step.parts);
                                return preserved !== step.parts ? { ...step, parts: preserved } : step;
                            });
                        }
                    }

                    return {
                        ...prev,
                        [event.chatId]: mergeMessages(existingMessages, [incomingMessage]),
                    };
                });

                if (isCompletedStream && event.message.role === 'ai') {
                    setPendingKey((current) => {
                        if (current === event.chatId) {
                            return null;
                        }
                        if (isOwnEvent && current === 'draft') {
                            return null;
                        }
                        return current;
                    });
                }
                return;
            }

            if (event.type === 'command.output' && event.commandId && event.chunk) {
                setCommandChunks((prev) => ({
                    ...prev,
                    [event.commandId]: [...(prev[event.commandId] ?? []), event.chunk],
                }));
                return;
            }

            if (event.type === 'agent.streaming' && event.chatId && event.messageId && event.payload) {
                const agentStreamingKey = getAgentStreamingKey(event.toolCallId, event.toolName);
                if (agentStreamingKey) {
                    setAgentStreaming((curr) => ({ ...curr, [agentStreamingKey]: event.payload }));
                }

                setMessagesByChat((prev) => {
                    const messages = prev[event.chatId] ?? [];
                    const messageIndex = messages.findIndex((m) => m.id === event.messageId);
                    if (messageIndex === -1) return prev;

                    const message = messages[messageIndex];
                    const toolCallId = event.toolCallId;
                    const hasToolCallId = typeof toolCallId === 'string' && toolCallId.trim().length > 0;

                    const matchesCall = (p) => (
                        p.functionCall && (
                            hasToolCallId
                                ? p.functionCall.id === toolCallId
                                : p.functionCall.name === event.toolName
                        )
                    );

                    const syntheticResponse = {
                        functionResponse: {
                            name: event.toolName || 'call_coding_agent',
                            id: toolCallId,
                            response: event.payload,
                        },
                    };

                    const matchesResponse = (p) => (
                        p.functionResponse && (
                            hasToolCallId
                                ? p.functionResponse.id === toolCallId
                                : p.functionResponse.name === event.toolName
                        )
                    );

                    const injectInto = (parts) => {
                        const next = [...parts];
                        const callIdx = next.findIndex(matchesCall);
                        if (callIdx === -1) return null;

                        const respIdx = next.findIndex((p, i) => i > callIdx && matchesResponse(p));
                        if (respIdx !== -1) {
                            next[respIdx] = syntheticResponse;
                        } else {
                            next.splice(callIdx + 1, 0, syntheticResponse);
                        }
                        return next;
                    };

                    const nextParts = injectInto(message.parts || []);
                    if (!nextParts && !toolCallId) return prev;

                    let nextSteps = message.steps;
                    if (Array.isArray(message.steps) && message.steps.length > 0) {
                        nextSteps = message.steps.map((step) => {
                            if (!Array.isArray(step?.parts) || step.parts.length === 0) return step;
                            const hasCall = step.parts.some(matchesCall);
                            if (!hasCall) return step;
                            const updatedParts = injectInto(step.parts);
                            return updatedParts ? { ...step, parts: updatedParts } : step;
                        });
                    }

                    const nextMessage = { ...message, parts: nextParts || message.parts, steps: nextSteps };
                    const nextMessages = [...messages];
                    nextMessages[messageIndex] = nextMessage;

                    return {
                        ...prev,
                        [event.chatId]: nextMessages,
                    };
                });
                return;
            }

            if (event.type === 'message.added' && event.chatId && event.message) {
                const pendingDraftChatId = pendingDraftChatIdRef.current;
                const agentStreamingKeys = collectAgentStreamingKeysFromMessage(event.message);
                if (agentStreamingKeys.size > 0) {
                    setAgentStreaming((prev) => {
                        let changed = false;
                        const next = { ...prev };
                        for (const key of agentStreamingKeys) {
                            if (!(key in next)) continue;
                            delete next[key];
                            changed = true;
                        }
                        return changed ? next : prev;
                    });
                }

                if (event.message.role === 'ai') {
                    setPendingKey((current) => {
                        if (current === event.chatId) {
                            return null;
                        }
                        if (isOwnEvent && current === 'draft') {
                            return null;
                        }
                        return current;
                    });
                }

                setMessagesByChat((prev) => {
                    if (!(event.chatId in prev) && !(isOwnEvent && pendingDraftChatId === event.chatId)) {
                        return prev;
                    }

                    return {
                        ...prev,
                        [event.chatId]: mergeMessages(prev[event.chatId] ?? [], [event.message]),
                    };
                });
                return;
            }

            if (isOwnEvent) {
                return;
            }

            if (event.type === 'chat.deleted' && event.chatId) {
                setChatSummaries((prev) => prev.filter((chat) => chat.id !== event.chatId));

                setMessagesByChat((prev) => {
                    if (!(event.chatId in prev)) return prev;

                    const next = { ...prev };
                    delete next[event.chatId];
                    return next;
                });

                setActiveChatId((current) => {
                    if (current !== event.chatId) return current;
                    const remaining = chatSummariesRef.current.filter((chat) => chat.id !== event.chatId);
                    return pickDefaultActiveChatId(remaining);
                });

                return;
            }


        });

        return () => {
            source.close();
        };
    }, []);

    const clearDraftComposer = useCallback(() => {
        const draftKey = getDraftKey(null);
        setDraftMessages([]);
        setPendingKey(null);
        pendingDraftChatIdRef.current = null;
        setDraftReplyContext(null);
        setInputDraftByKey((prev) => {
            if (!(draftKey in prev)) return prev;
            const next = { ...prev };
            delete next[draftKey];
            return next;
        });
        setInputAttachmentsByKey((prev) => {
            if (!(draftKey in prev)) return prev;
            const next = { ...prev };
            delete next[draftKey];
            return next;
        });
    }, []);

    const createNewChat = useCallback(() => {
        clearDraftComposer();
        activeChatIdRef.current = null;
        setActiveChatId(null);
    }, [clearDraftComposer]);

    const startReplyFromMessage = useCallback((message) => {
        const activeSummary = chatSummariesRef.current.find((chat) => chat.id === activeChatIdRef.current) ?? null;
        const sourceChatId = String(activeSummary?.id ?? activeChatIdRef.current ?? '').trim();
        const sourceMessageId = String(message?.id ?? '').trim();
        if (!sourceChatId || !sourceMessageId) {
            return;
        }

        clearDraftComposer();
        draftAgentIdRef.current = DEFAULT_AGENT_ID;
        setDraftAgentIdState(DEFAULT_AGENT_ID);
        setDraftReplyContext({
            chatId: sourceChatId,
            messageId: sourceMessageId,
            role: String(message?.role ?? '').trim().toLowerCase() === 'user' ? 'user' : 'ai',
            previewText: buildReplyPreviewText(message),
            chatTitle: String(activeSummary?.title ?? 'Inbox').trim() || 'Inbox',
        });
        activeChatIdRef.current = null;
        setActiveChatId(null);
    }, [clearDraftComposer]);

    const selectChat = useCallback((chatId) => {
        setDraftMessages([]);
        setDraftReplyContext(null);
        pendingDraftChatIdRef.current = null;
        setActiveChatId(chatId);
    }, []);

    const deleteChat = useCallback(async (chatId) => {
        await apiDeleteChat(chatId, clientIdRef.current);

        const remaining = chatSummariesRef.current.filter((chat) => chat.id !== chatId);
        setChatSummaries(remaining);

        setMessagesByChat((prev) => {
            if (!(chatId in prev)) return prev;

            const next = { ...prev };
            delete next[chatId];
            return next;
        });

        setActiveChatId((current) => {
            if (current !== chatId) return current;
            return pickDefaultActiveChatId(remaining);
        });

        setInputDraftByKey((prev) => {
            if (!(chatId in prev)) return prev;
            const next = { ...prev };
            delete next[chatId];
            return next;
        });

        setInputAttachmentsByKey((prev) => {
            if (!(chatId in prev)) return prev;
            const next = { ...prev };
            delete next[chatId];
            return next;
        });
        if (pendingDraftChatIdRef.current === chatId) {
            pendingDraftChatIdRef.current = null;
        }
    }, []);

    const setInputDraft = useCallback((value) => {
        const key = getDraftKey(activeChatId);
        const nextValue = String(value ?? '');

        setInputDraftByKey((prev) => {
            const currentValue = prev[key] ?? '';
            if (currentValue === nextValue) return prev;

            if (!nextValue) {
                if (!(key in prev)) return prev;
                const next = { ...prev };
                delete next[key];
                return next;
            }

            return {
                ...prev,
                [key]: nextValue,
            };
        });
    }, [activeChatId]);

    const setInputAttachments = useCallback((attachments) => {
        const key = getDraftKey(activeChatId);
        const normalized = normalizeDraftAttachments(attachments);

        setInputAttachmentsByKey((prev) => {
            if (normalized.length === 0) {
                if (!(key in prev)) return prev;
                const next = { ...prev };
                delete next[key];
                return next;
            }

            return {
                ...prev,
                [key]: normalized,
            };
        });
    }, [activeChatId]);

    const appendAiErrorToChat = useCallback((chatId, text) => {
        const errorMessage = createLocalMessage(createId('msg'), 'ai', text);

        if (!chatId) {
            setDraftMessages((prev) => mergeMessages(prev, [errorMessage]));
            return;
        }

        setMessagesByChat((prev) => ({
            ...prev,
            [chatId]: mergeMessages(prev[chatId] ?? [], [errorMessage]),
        }));
    }, []);

    const sendMessage = useCallback(async (payload) => {
        if (isHydrating) return;

        const normalizedPayload = normalizeSendPayload(payload);
        const trimmed = normalizedPayload.text.trim();
        const draftAttachments = normalizeDraftAttachments(normalizedPayload.attachments);
        const attachments = draftAttachments
            .filter((attachment) => attachment.status !== 'uploading' && attachment.uploadId && attachment.fileUri);
        const serializedAttachments = serializeOutgoingAttachments(draftAttachments);
        if (!trimmed && attachments.length === 0) return;

        const clientMessageId = createId('msg');
        const draftKey = getDraftKey(activeChatIdRef.current);
        const currentChatId = activeChatIdRef.current ?? pendingDraftChatIdRef.current ?? null;
        setInputDraftByKey((prev) => {
            if (!(draftKey in prev)) return prev;
            const next = { ...prev };
            delete next[draftKey];
            return next;
        });
        setInputAttachmentsByKey((prev) => {
            if (!(draftKey in prev)) return prev;
            const next = { ...prev };
            delete next[draftKey];
            return next;
        });

        const optimisticParts = buildUserMessageParts(trimmed, attachments);
        const draftReplyTarget = currentChatId === null ? draftReplyContextRef.current : null;

        if (currentChatId === null) {
            const optimisticUser = createLocalMessage(clientMessageId, 'user', trimmed, {
                parts: optimisticParts,
                replyTo: draftReplyTarget,
            });
            setDraftMessages([optimisticUser]);
            setPendingKey('draft');

            try {
                const responsePayload = await sendChatMessage({
                    message: trimmed,
                    attachments: serializedAttachments,
                    clientId: clientIdRef.current,
                    clientMessageId,
                    agentId: draftAgentIdRef.current,
                    isSteering: payload.isSteering,
                    replyTo: draftReplyTarget,
                });

                const chat = responsePayload.chat;
                const userMessage = responsePayload.userMessage;
                const aiMessage = responsePayload.aiMessage;

                setChatSummaries((prev) => upsertChatSummary(prev, chat));
                loadedChatIdsRef.current.add(chat.id);
                setMessagesByChat((prev) => ({
                    ...prev,
                    [chat.id]: mergeMessages([], [userMessage, aiMessage]),
                }));

                setDraftMessages([]);
                setDraftReplyContext(null);
                setActiveChatId(chat.id);
                pendingDraftChatIdRef.current = null;
            } catch (error) {
                pendingDraftChatIdRef.current = null;
                setInputDraftByKey((prev) => ({ ...prev, [draftKey]: trimmed }));
                if (attachments.length > 0) {
                    setInputAttachmentsByKey((prev) => ({ ...prev, [draftKey]: attachments }));
                }
                appendAiErrorToChat(null, toErrorMessage(error));
            } finally {
                setPendingKey(null);
            }

            return;
        }

        const chatId = currentChatId;
        const resolvedAgentId = chatAgentByIdRef.current.get(chatId) ?? draftAgentIdRef.current;
        const optimisticUser = createLocalMessage(clientMessageId, 'user', trimmed, {
            parts: optimisticParts,
        });
        setPendingKey(chatId);

        setMessagesByChat((prev) => ({
            ...prev,
            [chatId]: mergeMessages(prev[chatId] ?? [], [optimisticUser]),
        }));

        try {
            const responsePayload = await sendChatMessage({
                chatId,
                message: trimmed,
                attachments: serializedAttachments,
                clientId: clientIdRef.current,
                clientMessageId,
                agentId: resolvedAgentId,
                isSteering: payload.isSteering,
            });

            setChatSummaries((prev) => upsertChatSummary(prev, responsePayload.chat));
            setMessagesByChat((prev) => ({
                ...prev,
                [chatId]: mergeMessages(prev[chatId] ?? [], [responsePayload.userMessage, responsePayload.aiMessage]),
            }));
            if (pendingDraftChatIdRef.current === chatId) {
                pendingDraftChatIdRef.current = null;
            }
        } catch (error) {
            setInputDraftByKey((prev) => ({ ...prev, [draftKey]: trimmed }));
            if (attachments.length > 0) {
                setInputAttachmentsByKey((prev) => ({ ...prev, [draftKey]: attachments }));
            }
            appendAiErrorToChat(chatId, toErrorMessage(error));
        } finally {
            if (!payload.isSteering) {
                setPendingKey((current) => (current === chatId ? null : current));
            }
        }
    }, [appendAiErrorToChat, isHydrating]);

    const setDraftAgentId = useCallback((agentId) => {
        const normalized = String(agentId ?? '').trim() || DEFAULT_AGENT_ID;
        setDraftAgentIdState(normalized);
    }, []);

    const startNewChatWithMessage = useCallback(async ({
        text = '',
        attachments = [],
        agentId = DEFAULT_AGENT_ID,
        isSteering = false,
    } = {}) => {
        const normalizedAgentId = String(agentId ?? '').trim() || DEFAULT_AGENT_ID;

        draftAgentIdRef.current = normalizedAgentId;
        setDraftAgentIdState(normalizedAgentId);
        pendingDraftChatIdRef.current = null;
        activeChatIdRef.current = null;

        clearDraftComposer();
        setActiveChatId(null);

        await sendMessage({
            text,
            attachments,
            isSteering,
        });
    }, [clearDraftComposer, sendMessage]);

    const clearDraftReplyContext = useCallback(() => {
        setDraftReplyContext(null);
    }, []);

    const stopGeneration = useCallback(async () => {
        const chatId = activeChatIdRef.current;
        try {
            await stopChatGeneration({
                chatId: chatId === null || chatId === undefined ? undefined : chatId,
                clientId: clientIdRef.current,
            });
        } catch {
            // Ignore stop errors and let the current run finish naturally.
        }
    }, []);

    const activeMessages = useMemo(() => {
        if (activeChatId === null || activeChatId === undefined) {
            return draftMessages;
        }

        return messagesByChat[activeChatId] ?? [];
    }, [activeChatId, draftMessages, messagesByChat]);

    const recents = useMemo(
        () => chatSummaries.map((chat) => ({
            id: chat.id,
            label: chat.title,
            active: chat.id === activeChatId,
            kind: chat.kind,
            pinned: chat.pinned === true,
            deletable: chat.deletable !== false,
            unreadCount: Math.max(0, (chat.messageCount || 0) - (readCounts[chat.id] || 0)),
        })),
        [chatSummaries, activeChatId, readCounts],
    );
    const inputDraft = useMemo(
        () => inputDraftByKey[getDraftKey(activeChatId)] ?? '',
        [inputDraftByKey, activeChatId],
    );
    const inputAttachments = useMemo(
        () => inputAttachmentsByKey[getDraftKey(activeChatId)] ?? [],
        [inputAttachmentsByKey, activeChatId],
    );
    const activeChatSummary = useMemo(() => {
        if (activeChatId === null || activeChatId === undefined) {
            return null;
        }

        return chatSummaries.find((chat) => chat.id === activeChatId) ?? null;
    }, [chatSummaries, activeChatId]);

    const isDraftChat = activeChatId === null || activeChatId === undefined;
    const activeChatKind = isDraftChat
        ? null
        : (String(activeChatSummary?.kind ?? '').trim().toLowerCase() || null);
    const isInboxChatActive = activeChatKind === INBOX_CHAT_KIND;
    const activeChatAgentId = isDraftChat
        ? null
        : (String(activeChatSummary?.agentId ?? '').trim() || DEFAULT_AGENT_ID);
    const selectedAgentId = isDraftChat
        ? draftAgentId
        : (activeChatAgentId ?? DEFAULT_AGENT_ID);
    const isTyping = pendingKey !== null && (pendingKey === 'draft' || pendingKey === activeChatId);
    const greeting = `${getGreeting()}, Greeny`;

    return {
        greeting,
        messages: activeMessages,
        activeChatId,
        isTyping,
        isChatMode: activeMessages.length > 0 || !isDraftChat,
        sendMessage,
        stopGeneration,
        inputDraft,
        setInputDraft,
        inputAttachments,
        setInputAttachments,
        draftReplyContext,
        clearDraftReplyContext,
        recents,
        createNewChat,
        selectChat,
        deleteChat,
        startReplyFromMessage,
        isDraftChat,
        activeChatKind,
        isInboxChatActive,
        selectedAgentId,
        draftAgentId,
        setDraftAgentId,
        startNewChatWithMessage,
        activeChatAgentId,
        agentStreaming,
        commandChunks,
        clientId: clientIdRef.current,
    };
}
