import { useState, useRef, useMemo, useEffect, useCallback } from 'react';
import {
    deleteChat as apiDeleteChat,
    fetchChatMessages,
    fetchChats,
    openChatEvents,
    stopChatGeneration,
    sendChatMessage,
} from '../api/chatApi.js';

const CLIENT_ID_STORAGE_KEY = 'gemini-ui-client-id';
const ACTIVE_CHAT_STORAGE_KEY = 'gemini-ui-active-chat-id';
const DRAFT_AGENT_STORAGE_KEY = 'gemini-ui-draft-agent-id';
const DEFAULT_AGENT_ID = 'orchestrator';
const DRAFT_CHAT_KEY = '__draft__';

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
    return [...chats].sort((a, b) => b.updatedAt - a.updatedAt);
}

function getDraftKey(chatId) {
    return (chatId === null || chatId === undefined) ? DRAFT_CHAT_KEY : String(chatId);
}

function mergeMessages(existing, incoming) {
    const byId = new Map();

    for (const message of existing) {
        byId.set(message.id, message);
    }

    for (const message of incoming) {
        byId.set(message.id, message);
    }

    return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
}

function toErrorMessage(error) {
    if (error instanceof Error && error.message) {
        return `Gemini error: ${error.message}`;
    }

    return 'Gemini error: Request failed.';
}

function normalizeAttachmentMimeType(value) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (!normalized || !normalized.includes('/')) {
        return 'application/octet-stream';
    }

    return normalized;
}

function normalizeOutgoingAttachments(attachments) {
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
            const data = String(attachment.data ?? '').trim();
            const size = Number(attachment.size ?? 0);

            if (!data) {
                return null;
            }

            return {
                id,
                name,
                mimeType,
                data,
                size: Number.isFinite(size) && size > 0 ? Math.trunc(size) : 0,
            };
        })
        .filter(Boolean);
}

function buildUserMessageParts(text, attachments) {
    const normalizedText = String(text ?? '').trim();
    const normalizedAttachments = normalizeOutgoingAttachments(attachments);
    const parts = normalizedAttachments.map((attachment) => ({
        inlineData: {
            mimeType: attachment.mimeType,
            data: attachment.data,
            displayName: attachment.name,
        },
    }));

    if (normalizedText) {
        parts.push({ text: normalizedText });
    }

    return parts.length > 0 ? parts : null;
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
        attachments: normalizeOutgoingAttachments(payload.attachments),
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

export function useChat() {
    const [chatSummaries, setChatSummaries] = useState([]);
    const [messagesByChat, setMessagesByChat] = useState({});
    const [activeChatId, setActiveChatId] = useState(undefined);
    const [draftMessages, setDraftMessages] = useState([]);
    const [inputDraftByKey, setInputDraftByKey] = useState({});
    const [inputAttachmentsByKey, setInputAttachmentsByKey] = useState({});
    const [pendingKey, setPendingKey] = useState(null);
    const [draftAgentId, setDraftAgentIdState] = useState(() => getStoredDraftAgentId());
    const [isHydrating, setIsHydrating] = useState(true);
    const [agentStreaming, setAgentStreaming] = useState({});
    const [commandChunks, setCommandChunks] = useState({});

    const clientIdRef = useRef(getOrCreateClientId());
    const chatSummariesRef = useRef(chatSummaries);
    const activeChatIdRef = useRef(activeChatId);
    const loadedChatIdsRef = useRef(new Set());
    const preferredActiveChatIdRef = useRef(getStoredActiveChatId());
    const draftAgentIdRef = useRef(draftAgentId);
    const chatAgentByIdRef = useRef(new Map());

    useEffect(() => {
        chatSummariesRef.current = chatSummaries;
    }, [chatSummaries]);

    useEffect(() => {
        activeChatIdRef.current = activeChatId;
    }, [activeChatId]);

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
                    const preferred = preferredActiveChatIdRef.current;
                    if (preferred) {
                        const preferredExists = nextChats.some((chat) => chat.id === preferred);
                        if (preferredExists) return preferred;
                    }

                    return nextChats[0]?.id ?? null;
                }

                if (current === null) {
                    return null;
                }

                const exists = nextChats.some((chat) => chat.id === current);
                return exists ? current : (nextChats[0]?.id ?? null);
            });
        } finally {
            setIsHydrating(false);
        }
    }, []);

    const loadMessagesForChat = useCallback(async (chatId) => {
        if (!chatId || loadedChatIdsRef.current.has(chatId)) return;

        const payload = await fetchChatMessages(chatId);
        loadedChatIdsRef.current.add(chatId);
        setMessagesByChat((prev) => ({
            ...prev,
            [chatId]: payload.messages ?? [],
        }));
    }, []);

    useEffect(() => {
        refreshChats().catch(() => undefined);
    }, [refreshChats]);

    useEffect(() => {
        if (!activeChatId) return;
        loadMessagesForChat(activeChatId).catch(() => undefined);
    }, [activeChatId, loadMessagesForChat]);

    useEffect(() => {
        const source = openChatEvents((event) => {
            const isOwnEvent = event.originClientId === clientIdRef.current;

            if (event.type === 'chat.upsert' && event.chat) {
                // Include own upserts so a brand-new chat appears in Recents
                // immediately after pressing Enter on the first message.
                setChatSummaries((prev) => upsertChatSummary(prev, event.chat));
                return;
            }

            if (event.type === 'message.streaming' && event.chatId && event.message) {
                if (isOwnEvent && (activeChatIdRef.current === null || activeChatIdRef.current === undefined)) {
                    setDraftMessages((prev) => mergeMessages(prev, [event.message]));
                    return;
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
                                const alreadyPresent = result.some(p =>
                                    p.functionResponse && (p.functionResponse.id === toolId || p.functionResponse.name === toolName)
                                );
                                if (!alreadyPresent) {
                                    const callIndex = result.findIndex(p =>
                                        p.functionCall && (p.functionCall.id === toolId || p.functionCall.name === toolName)
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
                // Store agent streaming payload keyed by toolName — this is
                // reliable and matches the panel's activeAgentCallSelection.toolName.
                // IMPORTANT: must be outside setMessagesByChat updater (React anti-pattern).
                const toolName = String(event.toolName ?? '').trim();
                if (toolName) {
                    setAgentStreaming((curr) => ({ ...curr, [toolName]: event.payload }));
                }

                setMessagesByChat((prev) => {
                    const messages = prev[event.chatId] ?? [];
                    const messageIndex = messages.findIndex((m) => m.id === event.messageId);
                    if (messageIndex === -1) return prev;

                    const message = messages[messageIndex];
                    const toolCallId = event.toolCallId;

                    const matchesCall = (p) => (
                        p.functionCall && (p.functionCall.id === toolCallId || p.functionCall.name === event.toolName)
                    );

                    const syntheticResponse = {
                        functionResponse: {
                            name: event.toolName || 'call_coding_agent',
                            id: toolCallId,
                            response: event.payload,
                        },
                    };

                    const matchesResponse = (p) => (
                        p.functionResponse && (p.functionResponse.id === toolCallId || p.functionResponse.name === event.toolName)
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
                    const firstRemaining = chatSummariesRef.current.find((chat) => chat.id !== event.chatId);
                    return firstRemaining?.id ?? null;
                });

                return;
            }

            if (event.type === 'message.added' && event.chatId && event.message) {
                setAgentStreaming({});
                setMessagesByChat((prev) => {
                    if (!(event.chatId in prev)) {
                        return prev;
                    }

                    return {
                        ...prev,
                        [event.chatId]: mergeMessages(prev[event.chatId], [event.message]),
                    };
                });
            }
        });

        return () => {
            source.close();
        };
    }, []);

    const createNewChat = useCallback(() => {
        setActiveChatId((current) => {
            if (current === null) {
                return current;
            }

            setDraftMessages([]);
            setPendingKey(null);
            return null;
        });
    }, []);

    const selectChat = useCallback((chatId) => {
        setDraftMessages([]);
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
            return remaining[0]?.id ?? null;
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
        const normalized = normalizeOutgoingAttachments(attachments);

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
        const attachments = normalizeOutgoingAttachments(normalizedPayload.attachments);
        if (!trimmed && attachments.length === 0) return;

        const clientMessageId = createId('msg');
        const draftKey = getDraftKey(activeChatIdRef.current);
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

        if (activeChatIdRef.current === null || activeChatIdRef.current === undefined) {
            const optimisticUser = createLocalMessage(clientMessageId, 'user', trimmed, {
                parts: optimisticParts,
            });
            setDraftMessages([optimisticUser]);
            setPendingKey('draft');

            try {
                const responsePayload = await sendChatMessage({
                    message: trimmed,
                    attachments,
                    clientId: clientIdRef.current,
                    clientMessageId,
                    agentId: draftAgentIdRef.current,
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
                setActiveChatId(chat.id);
            } catch (error) {
                appendAiErrorToChat(null, toErrorMessage(error));
            } finally {
                setPendingKey(null);
            }

            return;
        }

        const chatId = activeChatIdRef.current;
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
                attachments,
                clientId: clientIdRef.current,
                clientMessageId,
                agentId: resolvedAgentId,
            });

            setChatSummaries((prev) => upsertChatSummary(prev, responsePayload.chat));
            setMessagesByChat((prev) => ({
                ...prev,
                [chatId]: mergeMessages(prev[chatId] ?? [], [responsePayload.userMessage, responsePayload.aiMessage]),
            }));
        } catch (error) {
            appendAiErrorToChat(chatId, toErrorMessage(error));
        } finally {
            setPendingKey((current) => (current === chatId ? null : current));
        }
    }, [appendAiErrorToChat, isHydrating]);

    const setDraftAgentId = useCallback((agentId) => {
        const normalized = String(agentId ?? '').trim() || DEFAULT_AGENT_ID;
        setDraftAgentIdState(normalized);
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
        })),
        [chatSummaries, activeChatId],
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
        recents,
        createNewChat,
        selectChat,
        deleteChat,
        isDraftChat,
        selectedAgentId,
        draftAgentId,
        setDraftAgentId,
        activeChatAgentId,
        agentStreaming,
        commandChunks,
    };
}
