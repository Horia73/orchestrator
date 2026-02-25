import { useState, useRef, useMemo, useEffect, useCallback } from 'react';
import {
    deleteChat as apiDeleteChat,
    fetchChatMessages,
    fetchChats,
    openChatEvents,
    sendChatMessage,
} from '../api/chatApi.js';

const CLIENT_ID_STORAGE_KEY = 'gemini-ui-client-id';

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

function sortChatsByRecent(chats) {
    return [...chats].sort((a, b) => b.updatedAt - a.updatedAt);
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

function createLocalMessage(id, role, text) {
    return {
        id,
        role,
        text,
        createdAt: Date.now(),
    };
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
    const [pendingKey, setPendingKey] = useState(null);
    const [isHydrating, setIsHydrating] = useState(true);

    const clientIdRef = useRef(getOrCreateClientId());
    const chatSummariesRef = useRef(chatSummaries);
    const activeChatIdRef = useRef(activeChatId);
    const loadedChatIdsRef = useRef(new Set());

    useEffect(() => {
        chatSummariesRef.current = chatSummaries;
    }, [chatSummaries]);

    useEffect(() => {
        activeChatIdRef.current = activeChatId;
    }, [activeChatId]);

    const refreshChats = useCallback(async () => {
        try {
            const payload = await fetchChats();
            const nextChats = sortChatsByRecent(payload.chats ?? []);
            setChatSummaries(nextChats);

            setActiveChatId((current) => {
                if (current === undefined) {
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

            if (event.type === 'chat.upsert' && event.chat) {
                setChatSummaries((prev) => upsertChatSummary(prev, event.chat));
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
    }, []);

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

    const sendMessage = useCallback(async (text) => {
        if (isHydrating) return;

        const trimmed = text.trim();
        if (!trimmed) return;

        const clientMessageId = createId('msg');

        if (activeChatIdRef.current === null || activeChatIdRef.current === undefined) {
            const optimisticUser = createLocalMessage(clientMessageId, 'user', trimmed);
            setDraftMessages([optimisticUser]);
            setPendingKey('draft');

            try {
                const payload = await sendChatMessage({
                    message: trimmed,
                    clientId: clientIdRef.current,
                    clientMessageId,
                });

                const chat = payload.chat;
                const userMessage = payload.userMessage;
                const aiMessage = payload.aiMessage;

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
        const optimisticUser = createLocalMessage(clientMessageId, 'user', trimmed);
        setPendingKey(chatId);

        setMessagesByChat((prev) => ({
            ...prev,
            [chatId]: mergeMessages(prev[chatId] ?? [], [optimisticUser]),
        }));

        try {
            const payload = await sendChatMessage({
                chatId,
                message: trimmed,
                clientId: clientIdRef.current,
                clientMessageId,
            });

            setChatSummaries((prev) => upsertChatSummary(prev, payload.chat));
            setMessagesByChat((prev) => ({
                ...prev,
                [chatId]: mergeMessages(prev[chatId] ?? [], [payload.userMessage, payload.aiMessage]),
            }));
        } catch (error) {
            appendAiErrorToChat(chatId, toErrorMessage(error));
        } finally {
            setPendingKey((current) => (current === chatId ? null : current));
        }
    }, [appendAiErrorToChat, isHydrating]);

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

    const isDraftChat = activeChatId === null || activeChatId === undefined;
    const isTyping = isHydrating || (
        pendingKey !== null
        && (pendingKey === 'draft' || pendingKey === activeChatId)
    );
    const greeting = `${getGreeting()}, Greeny`;

    return {
        greeting,
        messages: activeMessages,
        isTyping,
        isChatMode: activeMessages.length > 0,
        sendMessage,
        recents,
        createNewChat,
        selectChat,
        deleteChat,
        isDraftChat,
    };
}
