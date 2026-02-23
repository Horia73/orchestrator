import { generateId } from '../utils/ids.js';
import { loadRuntimeSettings, saveRuntimeSettings } from '../services/api.js';
import { storage } from '../services/storage.js';

const DEFAULT_ASSISTANT_PROFILE = {
    name: 'AI Chat',
    emoji: '🤖',
};
const ASSISTANT_PROFILE_SYNC_MS = 10000;

function compactText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function firstGrapheme(value) {
    const text = String(value || '').trim();
    if (!text) return '';
    if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
        try {
            const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
            const iterator = segmenter.segment(text)[Symbol.iterator]();
            const first = iterator.next();
            return first?.value?.segment || '';
        } catch {
            // ignore and fallback below
        }
    }
    return Array.from(text)[0] || '';
}

function normalizeAssistantProfile(input) {
    const raw = input && typeof input === 'object' ? input : {};
    const name = compactText(raw.name).slice(0, 48) || DEFAULT_ASSISTANT_PROFILE.name;
    const emoji = firstGrapheme(raw.emoji) || DEFAULT_ASSISTANT_PROFILE.emoji;
    return { name, emoji };
}

function extractAssistantProfileFromSettings(settings) {
    return normalizeAssistantProfile(settings?.ui?.assistantProfile || {});
}

/**
 * Scalable reactive state store with IndexedDB persistence.
 * Handles 1000+ conversations by lazy-loading messages.
 */
class Store {
    constructor() {
        this.listeners = new Set();
        this.state = {
            conversations: [], // Metadata only: { id, title, updatedAt, ... }
            messages: [],      // Messages for the ACTIVE conversation only
            activeConversationId: null,
            sidebarOpen: false,
            loading: true,
            streaming: null,
            assistantProfile: { ...DEFAULT_ASSISTANT_PROFILE },
        };
        this.assistantProfileSyncTimer = null;
        this.onWindowFocus = () => {
            void this.refreshAssistantProfileFromServer();
        };
        this.onVisibilityChange = () => {
            if (document.visibilityState === 'visible') {
                void this.refreshAssistantProfileFromServer();
            }
        };

        // Initial load
        this._init().then(() => {
            console.log('Store initialized with DB');
        });
    }

    async _init() {
        try {
            this.state.conversations = await storage.getAllConversations();

            // Restore last active conversation if possible
            const lastActiveId = localStorage.getItem('lastActiveConversationId');
            if (lastActiveId && this.state.conversations.find(c => c.id === lastActiveId)) {
                await this.setActiveConversation(lastActiveId);
            } else {
                this.state.loading = false;
                this._notify();
            }
        } catch (e) {
            console.error('Store init failed:', e);
            this.state.loading = false;
            this._notify();
        }

        await this.refreshAssistantProfileFromServer();
        this.startAssistantProfileSync();
    }

    _notify() {
        // Clone state to avoid direct mutation bugs in UI
        /* In vanilla JS with large objects, structuredClone can be expensive on every notify.
           Passing ref usage is acceptable if we trust the UI not to mutate. */
        this.listeners.forEach((fn) => fn(this.state));
    }

    subscribe(fn) {
        this.listeners.add(fn);
        // Immediately call with current state
        fn(this.state);
        return () => this.listeners.delete(fn);
    }

    getState() {
        return this.state;
    }

    getActiveConversation() {
        return this.getActiveConversationMetadata();
    }

    getActiveConversationMetadata() {
        return this.state.conversations.find(
            (c) => c.id === this.state.activeConversationId
        );
    }

    getMessages() {
        return this.state.messages;
    }

    getLastMessage() {
        return this.state.messages[this.state.messages.length - 1];
    }

    getStreamingState() {
        return this.state.streaming;
    }

    getAssistantProfile() {
        return this.state.assistantProfile;
    }

    setAssistantProfileLocal(profile, { notify = true } = {}) {
        const next = normalizeAssistantProfile(profile);
        const current = this.state.assistantProfile || DEFAULT_ASSISTANT_PROFILE;
        if (next.name === current.name && next.emoji === current.emoji) {
            return current;
        }
        this.state.assistantProfile = next;
        if (notify) this._notify();
        return next;
    }

    async refreshAssistantProfileFromServer() {
        try {
            const settings = await loadRuntimeSettings();
            const serverProfile = extractAssistantProfileFromSettings(settings);
            return this.setAssistantProfileLocal(serverProfile);
        } catch (error) {
            console.warn('Failed to refresh assistant profile from server:', error);
            return this.state.assistantProfile;
        }
    }

    startAssistantProfileSync() {
        if (this.assistantProfileSyncTimer) return;
        if (typeof window === 'undefined' || typeof document === 'undefined') return;

        this.assistantProfileSyncTimer = setInterval(() => {
            if (document.visibilityState === 'hidden') return;
            void this.refreshAssistantProfileFromServer();
        }, ASSISTANT_PROFILE_SYNC_MS);

        window.addEventListener('focus', this.onWindowFocus);
        document.addEventListener('visibilitychange', this.onVisibilityChange);
    }

    async setAssistantProfile(patch = {}) {
        const next = normalizeAssistantProfile({
            ...(this.state.assistantProfile || DEFAULT_ASSISTANT_PROFILE),
            ...(patch || {}),
        });

        try {
            const updated = await saveRuntimeSettings({
                ui: {
                    assistantProfile: next,
                },
            });
            const confirmedProfile = extractAssistantProfileFromSettings(updated);
            return this.setAssistantProfileLocal(confirmedProfile);
        } catch (error) {
            console.error('Failed to save assistant profile to server:', error);
            await this.refreshAssistantProfileFromServer();
            throw error;
        }
    }

    setStreamingState(conversationId, prompt) {
        this.state.streaming = {
            conversationId,
            prompt,
            startedAt: new Date().toISOString(),
        };
        this._notify();
    }

    clearStreamingState() {
        if (!this.state.streaming) return;
        this.state.streaming = null;
        this._notify();
    }

    // ─── Actions ───

    async createConversation() {
        const id = generateId();
        const conv = {
            id,
            title: 'New Chat',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        };

        // Update local state
        this.state.conversations.unshift(conv);

        // Optimistic UI update
        // We set active, which clears messages for the new blank chat
        this.state.activeConversationId = id;
        this.state.messages = [];
        this.state.sidebarOpen = false;
        this._notify();

        // Persist
        try {
            await storage.saveConversation(conv);
        } catch (e) {
            console.error('Failed to persist conversation metadata:', e);
        }
        localStorage.setItem('lastActiveConversationId', id);

        return conv;
    }

    async setActiveConversation(id) {
        if (this.state.activeConversationId === id) return;

        this.state.activeConversationId = id;
        this.state.sidebarOpen = false;
        this.state.loading = true; // Show loading state if needed
        this._notify(); // Notify immediately to switch UI context

        try {
            // Async load messages
            const messages = await storage.getMessagesForConversation(id);
            this.state.messages = messages;
        } catch (e) {
            console.error('Failed to load messages', e);
            this.state.messages = [];
        } finally {
            this.state.loading = false;
            this._notify();
            localStorage.setItem('lastActiveConversationId', id);
        }
    }

    async deleteConversation(id) {
        // Ensure string comparison
        const targetId = String(id);

        // Update Metadata List
        this.state.conversations = this.state.conversations.filter(
            (c) => String(c.id) !== targetId
        );

        // If deleting active one, reset
        if (String(this.state.activeConversationId) === targetId) {
            this.state.activeConversationId = null;
            this.state.messages = [];
            this.state.streaming = null;
            localStorage.removeItem('lastActiveConversationId');
        }

        this._notify();
        try {
            await storage.deleteConversation(targetId);
        } catch (e) {
            console.error('Failed to delete conversation from storage:', e);
        }
    }

    async addMessage(role, content, attachments, extra = {}) {
        const activeId = this.state.activeConversationId;
        if (!activeId) return;
        const textContent = typeof content === 'string' ? content : '';
        const hasAttachments = Array.isArray(attachments) && attachments.length > 0;

        const message = {
            id: generateId(),
            conversationId: activeId,
            role, // 'user' | 'ai' | 'system'
            content: textContent,
            attachments: attachments || null,
            createdAt: new Date().toISOString(),
            ...extra,
        };

        // 1. Update In-Memory Messages (Immediate UI Feedback)
        this.state.messages.push(message);

        // 2. Update Metadata (updatedAt, title)
        const conv = this.state.conversations.find(c => c.id === activeId);
        if (conv) {
            conv.updatedAt = new Date().toISOString();
            // Auto-title from first user message
            if (role === 'user' && this.state.messages.filter(m => m.role === 'user').length === 1) {
                const titleSource = textContent.trim() || (hasAttachments ? 'Attachments' : 'New Chat');
                conv.title = titleSource.slice(0, 50) + (titleSource.length > 50 ? '…' : '');
            }
            // Move to top
            this.state.conversations = [
                conv,
                ...this.state.conversations.filter(c => c.id !== activeId)
            ];
        }

        this._notify();

        // 3. Persist Async
        const messageForStorage = {
            ...message,
            attachments: normalizeAttachmentsForStorage(message.attachments),
        };
        try {
            await Promise.all([
                storage.saveMessage(messageForStorage),
                conv ? storage.saveConversation(conv) : Promise.resolve(),
            ]);
        } catch (e) {
            console.error('Failed to persist message or metadata:', e);
        }

        return message;
    }

    async updateMessage(messageId, patch) {
        const message = this.state.messages.find((m) => m.id === messageId);
        if (!message) return null;

        // Merge metadata objects safely while allowing full replacement when needed.
        if (patch && typeof patch.meta === 'object' && patch.meta !== null) {
            message.meta = {
                ...(message.meta || {}),
                ...patch.meta,
            };
        }

        Object.keys(patch || {}).forEach((key) => {
            if (key === 'meta') return;
            message[key] = patch[key];
        });

        this._notify();

        const messageForStorage = {
            ...message,
            attachments: normalizeAttachmentsForStorage(message.attachments),
        };
        try {
            await storage.saveMessage(messageForStorage);
        } catch (e) {
            console.error('Failed to persist message update:', e);
        }

        return message;
    }

    async updateMessageById(messageId, patch) {
        const inMemory = this.state.messages.find((m) => m.id === messageId);
        if (inMemory) {
            return this.updateMessage(messageId, patch);
        }

        let storedMessage = null;
        try {
            storedMessage = await storage.getMessage(messageId);
        } catch (e) {
            console.error('Failed to load message from storage:', e);
            return null;
        }

        if (!storedMessage) return null;

        const nextMessage = { ...storedMessage };
        if (patch && typeof patch.meta === 'object' && patch.meta !== null) {
            nextMessage.meta = {
                ...(nextMessage.meta || {}),
                ...patch.meta,
            };
        }

        Object.keys(patch || {}).forEach((key) => {
            if (key === 'meta') return;
            nextMessage[key] = patch[key];
        });

        const messageForStorage = {
            ...nextMessage,
            attachments: normalizeAttachmentsForStorage(nextMessage.attachments),
        };

        try {
            await storage.saveMessage(messageForStorage);
        } catch (e) {
            console.error('Failed to persist off-screen message update:', e);
            return null;
        }

        return nextMessage;
    }

    async updateLastAiMessage(content) {
        // Updates in-memory first
        const lastAi = [...this.state.messages].reverse().find((m) => m.role === 'ai');
        if (lastAi) {
            lastAi.content = content;
            this._notify();

            // Persist
            const messageForStorage = {
                ...lastAi,
                attachments: normalizeAttachmentsForStorage(lastAi.attachments),
            };
            try {
                await storage.saveMessage(messageForStorage);
            } catch (e) {
                console.error('Failed to persist AI message update:', e);
            }
        }
    }

    toggleSidebar() {
        this.state.sidebarOpen = !this.state.sidebarOpen;
        this._notify();
    }

    closeSidebar() {
        this.state.sidebarOpen = false;
        this._notify();
    }
}

function normalizeAttachmentsForStorage(attachments) {
    if (!Array.isArray(attachments) || attachments.length === 0) return null;
    return attachments.map((attachment) => {
        const normalized = { ...attachment };

        // Blob URLs are session-scoped and become invalid after reload.
        if (typeof normalized.url === 'string' && normalized.url.startsWith('blob:')) {
            delete normalized.url;
            normalized.unavailableAfterReload = true;
        }

        // Avoid persisting transient fields.
        if ('file' in normalized) delete normalized.file;

        return normalized;
    });
}

export const store = new Store();
