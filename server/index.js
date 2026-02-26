import express from 'express';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { API_PORT, GEMINI_CONTEXT_MESSAGES } from './config.js';
import { generateAssistantReplyStream, listAvailableModels } from './geminiService.js';
import { openEventsStream, broadcastEvent } from './events.js';
import { getCommandStatusSnapshot } from './tools.js';
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
const activeGenerationsByClient = new Map();

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

function registerActiveGeneration(clientId, chatId) {
    const generation = {
        clientId,
        chatId,
        stopRequested: false,
    };

    const existing = activeGenerationsByClient.get(clientId) ?? new Set();
    existing.add(generation);
    activeGenerationsByClient.set(clientId, existing);
    return generation;
}

function unregisterActiveGeneration(generation) {
    if (!generation) return;

    const existing = activeGenerationsByClient.get(generation.clientId);
    if (!existing) return;

    existing.delete(generation);
    if (existing.size === 0) {
        activeGenerationsByClient.delete(generation.clientId);
    }
}

function requestStopForClient(clientId, chatId) {
    const existing = activeGenerationsByClient.get(clientId);
    if (!existing || existing.size === 0) {
        return 0;
    }

    let stoppedCount = 0;
    for (const generation of existing) {
        if (chatId && generation.chatId !== chatId) {
            continue;
        }

        if (!generation.stopRequested) {
            generation.stopRequested = true;
            stoppedCount += 1;
        }
    }

    return stoppedCount;
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

app.post('/api/chat/stop', (req, res) => {
    const clientId = normalizeClientId(req.body?.clientId);
    const requestedChatId = String(req.body?.chatId ?? '').trim();
    const chatId = requestedChatId || null;
    const stoppedCount = requestStopForClient(clientId, chatId);

    res.json({
        ok: true,
        stoppedCount,
    });
});

app.get('/api/commands/:commandId/status', async (req, res) => {
    const commandId = String(req.params?.commandId ?? '').trim();
    const waitDurationSeconds = Number(req.query?.wait ?? 0);
    const outputCharacterCount = Number(req.query?.chars ?? 12_000);

    const snapshot = await getCommandStatusSnapshot({
        commandId,
        waitDurationSeconds,
        outputCharacterCount,
    });

    if (snapshot?.error) {
        const statusCode = snapshot.error.startsWith('Unknown command id') ? 404 : 400;
        res.status(statusCode).json(snapshot);
        return;
    }

    res.json(snapshot);
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
            let streamedAssistantSteps = [];
            let assistantText;

            broadcastEvent('message.streaming', {
                chatId: chat.id,
                message: {
                    id: aiMessageId,
                    chatId: chat.id,
                    role: 'ai',
                    text: '',
                    thought: '',
                    parts: [],
                    steps: [],
                    createdAt: aiMessageCreatedAt,
                },
                originClientId: clientId,
            });

            const activeGeneration = registerActiveGeneration(clientId, chat.id);
            try {
                const streamResult = await generateAssistantReplyStream(history, {
                    onUpdate: async ({ text, thought, parts, steps }) => {
                        streamedAssistantText = text;
                        streamedAssistantThought = thought;
                        streamedAssistantParts = Array.isArray(parts) ? parts : streamedAssistantParts;
                        streamedAssistantSteps = Array.isArray(steps) ? steps : streamedAssistantSteps;
                        broadcastEvent('message.streaming', {
                            chatId: chat.id,
                            message: {
                                id: aiMessageId,
                                chatId: chat.id,
                                role: 'ai',
                                text,
                                thought,
                                parts: streamedAssistantParts,
                                steps: streamedAssistantSteps,
                                createdAt: aiMessageCreatedAt,
                            },
                            originClientId: clientId,
                        });
                    },
                    shouldStop: () => activeGeneration.stopRequested,
                });
                assistantText = String(streamResult.text ?? '').trim();
                if (streamResult.stopped) {
                    if (!assistantText) {
                        assistantText = 'Stopped.';
                    } else if (!assistantText.endsWith('Stopped.')) {
                        assistantText = `${assistantText}\n\nStopped.`;
                    }
                } else if (!assistantText) {
                    assistantText = 'No text response was returned by Gemini.';
                }
                streamedAssistantThought = streamResult.thought;
                streamedAssistantParts = Array.isArray(streamResult.parts)
                    ? streamResult.parts
                    : streamedAssistantParts;
                streamedAssistantSteps = Array.isArray(streamResult.steps)
                    ? streamResult.steps
                    : streamedAssistantSteps;

                // Ensure the final streaming frame contains per-step snapshots.
                broadcastEvent('message.streaming', {
                    chatId: chat.id,
                    message: {
                        id: aiMessageId,
                        chatId: chat.id,
                        role: 'ai',
                        text: assistantText,
                        thought: streamedAssistantThought,
                        parts: streamedAssistantParts,
                        steps: streamedAssistantSteps,
                        createdAt: aiMessageCreatedAt,
                    },
                    originClientId: clientId,
                });
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
                        parts: streamedAssistantParts,
                        steps: streamedAssistantSteps,
                        createdAt: aiMessageCreatedAt,
                    },
                    originClientId: clientId,
                });
            } finally {
                unregisterActiveGeneration(activeGeneration);
            }

            const appendedAi = await appendMessage(chat.id, {
                id: aiMessageId,
                role: 'ai',
                text: assistantText,
                thought: streamedAssistantThought,
                parts: streamedAssistantParts,
                steps: streamedAssistantSteps,
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
