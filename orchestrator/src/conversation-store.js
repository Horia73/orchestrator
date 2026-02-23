export class ConversationStore {
  constructor(maxMessagesPerConversation = 0) {
    const parsed = Number(maxMessagesPerConversation);
    this.maxMessages = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
    this.store = new Map();
  }

  getHistory(conversationId) {
    const key = String(conversationId || '');
    if (!key) return [];
    const history = this.store.get(key);
    return Array.isArray(history) ? [...history] : [];
  }

  append(conversationId, role, content) {
    const key = String(conversationId || '');
    if (!key) return;
    if (!this.store.has(key)) {
      this.store.set(key, []);
    }

    const history = this.store.get(key);
    history.push({
      role,
      content: String(content || ''),
      at: new Date().toISOString(),
    });

    if (this.maxMessages > 0 && history.length > this.maxMessages) {
      const trimmed = history.slice(-this.maxMessages);
      this.store.set(key, trimmed);
    }
  }
}
