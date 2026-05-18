import { EventEmitter } from 'events';
import type { ContextUsageSnapshot, Message } from '@/lib/types';

// In Next.js development, the global object gets recreated on fast refresh,
// so we need a persistent way to maintain the EventEmitter across reloads.
const globalForEvents = globalThis as unknown as {
    chatEventEmitter?: EventEmitter;
};

export const chatEventEmitter = globalForEvents.chatEventEmitter || new EventEmitter();

// Increase max listeners if you expect many simultaneous connections
chatEventEmitter.setMaxListeners(100);

if (process.env.NODE_ENV !== 'production') {
    globalForEvents.chatEventEmitter = chatEventEmitter;
}

// Event Types
export type ChatEvent =
    | { type: 'create_conversation'; payload: { id: string; title: string; createdAt: number; messages?: Message[] } }
    | { type: 'add_message'; payload: { conversationId: string; message: Message } }
    | { type: 'context_usage'; payload: { conversationId: string; contextUsage: ContextUsageSnapshot } }
    | { type: 'delete_conversation'; payload: { id: string } };

export function emitChatEvent(event: ChatEvent) {
    chatEventEmitter.emit('chat:update', event);
}
