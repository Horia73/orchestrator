
const DB_NAME = 'ai_chat_db';
const DB_VERSION = 1;
const STORES = {
    CONVERSATIONS: 'conversations',
    MESSAGES: 'messages'
};

/**
 * IndexedDB Service for scalable storage
 */
class StorageService {
    constructor() {
        this.dbPromise = this._initDB();
    }

    _initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onerror = (event) => reject('DB Error: ' + event.target.error);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;

                // Conversations store (metadata only)
                if (!db.objectStoreNames.contains(STORES.CONVERSATIONS)) {
                    const convStore = db.createObjectStore(STORES.CONVERSATIONS, { keyPath: 'id' });
                    convStore.createIndex('updatedAt', 'updatedAt', { unique: false });
                }

                // Messages store
                if (!db.objectStoreNames.contains(STORES.MESSAGES)) {
                    const msgStore = db.createObjectStore(STORES.MESSAGES, { keyPath: 'id' });
                    msgStore.createIndex('conversationId', 'conversationId', { unique: false });
                }
            };

            request.onsuccess = (event) => resolve(event.target.result);
        });
    }

    async getDB() {
        return this.dbPromise;
    }

    // ─── API ───

    async getAllConversations() {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORES.CONVERSATIONS], 'readonly');
            const store = transaction.objectStore(STORES.CONVERSATIONS);
            const request = store.getAll(); // Get all metadata

            request.onsuccess = () => {
                // Sort by updatedAt desc by default
                const result = request.result.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
                resolve(result);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async saveConversation(conversation) {
        // Save metadata only (strip messages if present to avoid duplication/bloat in this store)
        const { messages, ...meta } = conversation;

        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORES.CONVERSATIONS], 'readwrite');
            const store = transaction.objectStore(STORES.CONVERSATIONS);
            const request = store.put(meta);

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async saveMessage(message) {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORES.MESSAGES], 'readwrite');
            const store = transaction.objectStore(STORES.MESSAGES);
            const request = store.put(message);

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    async getMessage(id) {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORES.MESSAGES], 'readonly');
            const store = transaction.objectStore(STORES.MESSAGES);
            const request = store.get(id);

            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    }

    async getMessagesForConversation(conversationId) {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORES.MESSAGES], 'readonly');
            const store = transaction.objectStore(STORES.MESSAGES);
            const index = store.index('conversationId');
            const request = index.getAll(conversationId);

            request.onsuccess = () => {
                // Sort by createdAt asc
                const result = request.result.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
                resolve(result);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async deleteConversation(id) {
        const db = await this.getDB();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction([STORES.CONVERSATIONS, STORES.MESSAGES], 'readwrite');

            // Delete metadata
            const convStore = transaction.objectStore(STORES.CONVERSATIONS);
            convStore.delete(id);

            // Delete associated messages
            const msgStore = transaction.objectStore(STORES.MESSAGES);
            const index = msgStore.index('conversationId');
            const req = index.openCursor(IDBKeyRange.only(id));

            req.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    cursor.delete();
                    cursor.continue();
                }
            };

            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        });
    }
}

export const storage = new StorageService();
