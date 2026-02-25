import express from 'express';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { API_PORT, GEMINI_CONTEXT_MESSAGES } from './config.js';
import { generateAssistantReplyStream, listAvailableModels } from './geminiService.js';
import { openEventsStream, broadcastEvent } from './events.js';
import {
    initStorage,
    listChats,
    getChat,
    createChatFromFirstMessage,
    appendMessage,
    getChatMessages,
    getRecentMessages,
    removeChat,
} from './storage.js';
import { readSettings, writeSettings } from './settings.js';

const app = express();
app.use(express.json({ limit: '2mb' }));

const chatQueues = new Map();

function createMessageId() {
    return `msg-${randomUUID()}`;
}

function formatGeminiError(error) {
    if (error instanceof Error && error.message) {
        return `Gemini error: ${error.message}`;
    }

    return 'Gemini error: Request failed.';
}

function normalizeMessageText(value) {
    return String(value ?? '').trim();
}

function normalizeClientId(value) {
    const normalized = String(value ?? '').trim();
    return normalized || 'unknown-client';
}

function enqueueChatWork(chatId, task) {
    const previous = chatQueues.get(chatId) ?? Promise.resolve();
    const run = previous
        .catch(() => undefined)
        .then(task)
        .finally(() => {
            if (chatQueues.get(chatId) === run) {
                chatQueues.delete(chatId);
            }
        });

    chatQueues.set(chatId, run);
    return run;
}

app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
});

app.get('/api/events', (req, res) => {
    openEventsStream(req, res);
});

/* ---- Settings endpoints ---- */
app.get('/api/settings', (_req, res) => {
    try {
        const settings = readSettings();
        res.json({ settings });
    } catch {
        res.status(500).json({ error: 'Failed to read settings.' });
    }
});

app.put('/api/settings', (req, res) => {
    try {
        const settings = req.body?.settings;
        if (!settings || typeof settings !== 'object') {
            res.status(400).json({ error: 'Invalid settings payload.' });
            return;
        }
        writeSettings(settings);
        res.json({ ok: true, settings });
    } catch {
        res.status(500).json({ error: 'Failed to save settings.' });
    }
});

app.get('/api/models', async (_req, res) => {
    try {
        const models = await listAvailableModels();
        res.json({ models });
    } catch {
        res.status(500).json({ error: 'Failed to fetch models.' });
    }
});

app.get('/api/chats', async (_req, res, next) => {
    try {
        const chats = await listChats();
        res.json({ chats });
    } catch (error) {
        next(error);
    }
});

app.get('/api/chats/:chatId/messages', async (req, res, next) => {
    try {
        const { chatId } = req.params;
        const chat = await getChat(chatId);
        if (!chat) {
            res.status(404).json({ error: 'Chat not found.' });
            return;
        }

        const messages = await getChatMessages(chatId);
        res.json({ chat, messages });
    } catch (error) {
        next(error);
    }
});

app.delete('/api/chats/:chatId', async (req, res, next) => {
    try {
        const { chatId } = req.params;
        const clientId = normalizeClientId(req.query.clientId);

        const removed = await removeChat(chatId);
        if (!removed) {
            res.status(404).json({ error: 'Chat not found.' });
            return;
        }

        broadcastEvent('chat.deleted', {
            chatId,
            originClientId: clientId,
        });

        res.json({ ok: true });
    } catch (error) {
        next(error);
    }
});

app.post('/api/chat/send', async (req, res, next) => {
    try {
        const inputText = normalizeMessageText(req.body?.message);
        if (!inputText) {
            res.status(400).json({ error: 'Message is required.' });
            return;
        }

        const clientId = normalizeClientId(req.body?.clientId);
        const clientMessageId = String(req.body?.clientMessageId ?? '').trim() || createMessageId();
        const requestedChatId = String(req.body?.chatId ?? '').trim();

        let chat = requestedChatId ? await getChat(requestedChatId) : null;
        let created = false;

        if (!chat) {
            if (requestedChatId) {
                res.status(404).json({ error: 'Chat not found.' });
                return;
            }

            chat = await createChatFromFirstMessage(inputText);
            created = true;
            broadcastEvent('chat.upsert', {
                chat,
                originClientId: clientId,
            });
        }

        const result = await enqueueChatWork(chat.id, async () => {
            const appendedUser = await appendMessage(chat.id, {
                id: clientMessageId,
                role: 'user',
                text: inputText,
            });

            broadcastEvent('message.added', {
                chatId: chat.id,
                message: appendedUser.message,
                originClientId: clientId,
            });

            broadcastEvent('chat.upsert', {
                chat: appendedUser.chat,
                originClientId: clientId,
            });

            const history = await getRecentMessages(chat.id, GEMINI_CONTEXT_MESSAGES + 1);

            const aiMessageId = createMessageId();
            const aiMessageCreatedAt = Date.now();
            let streamedAssistantText = '';
            let streamedAssistantThought = '';
            let streamedAssistantParts = [];
            let assistantText;

            broadcastEvent('message.streaming', {
                chatId: chat.id,
                message: {
                    id: aiMessageId,
                    chatId: chat.id,
                    role: 'ai',
                    text: '',
                    thought: '',
                    createdAt: aiMessageCreatedAt,
                },
                originClientId: clientId,
            });

            try {
                const streamResult = await generateAssistantReplyStream(history, {
                    onUpdate: async ({ text, thought, parts }) => {
                        streamedAssistantText = text;
                        streamedAssistantThought = thought;
                        streamedAssistantParts = Array.isArray(parts) ? parts : streamedAssistantParts;
                        broadcastEvent('message.streaming', {
                            chatId: chat.id,
                            message: {
                                id: aiMessageId,
                                chatId: chat.id,
                                role: 'ai',
                                text,
                                thought,
                                createdAt: aiMessageCreatedAt,
                            },
                            originClientId: clientId,
                        });
                    },
                });
                assistantText = streamResult.text;
                streamedAssistantThought = streamResult.thought;
                streamedAssistantParts = Array.isArray(streamResult.parts)
                    ? streamResult.parts
                    : streamedAssistantParts;
            } catch (error) {
                const formattedError = formatGeminiError(error);
                assistantText = streamedAssistantText
                    ? `${streamedAssistantText}\n\n${formattedError}`
                    : formattedError;

                broadcastEvent('message.streaming', {
                    chatId: chat.id,
                    message: {
                        id: aiMessageId,
                        chatId: chat.id,
                        role: 'ai',
                        text: assistantText,
                        thought: streamedAssistantThought,
                        createdAt: aiMessageCreatedAt,
                    },
                    originClientId: clientId,
                });
            }

            const appendedAi = await appendMessage(chat.id, {
                id: aiMessageId,
                role: 'ai',
                text: assistantText,
                thought: streamedAssistantThought,
                parts: streamedAssistantParts,
                createdAt: aiMessageCreatedAt,
            });

            broadcastEvent('message.added', {
                chatId: chat.id,
                message: appendedAi.message,
                originClientId: clientId,
            });

            broadcastEvent('chat.upsert', {
                chat: appendedAi.chat,
                originClientId: clientId,
            });

            return {
                chat: appendedAi.chat,
                userMessage: appendedUser.message,
                aiMessage: appendedAi.message,
            };
        });

        res.json({
            ...result,
            created,
        });
    } catch (error) {
        next(error);
    }
});

app.use((error, _req, res, next) => {
    void next;
    const message = error instanceof Error ? error.message : 'Unknown server error.';
    res.status(500).json({ error: message });
});

async function start() {
    await initStorage();

    const server = http.createServer(app);

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(API_PORT, () => {
            console.log(`API listening on http://localhost:${API_PORT}`);
            resolve();
        });
    });

    const shutdown = () => {
        server.close(() => {
            process.exit(0);
        });
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

start().catch((error) => {
    console.error(error);
    process.exit(1);
});
