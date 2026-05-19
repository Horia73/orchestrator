import { EventEmitter } from 'events';
import type { ContextUsageSnapshot, Message } from '@/lib/types';

// In Next.js development, the global object gets recreated on fast refresh,
// so we need a persistent way to maintain the EventEmitter across reloads.
const globalForEvents = globalThis as unknown as {
    chatEventEmitter?: EventEmitter;
    appEventEmitter?: EventEmitter;
};

export const chatEventEmitter = globalForEvents.chatEventEmitter || new EventEmitter();
export const appEventEmitter = globalForEvents.appEventEmitter || new EventEmitter();

// Increase max listeners if you expect many simultaneous connections
chatEventEmitter.setMaxListeners(100);
appEventEmitter.setMaxListeners(100);

if (process.env.NODE_ENV !== 'production') {
    globalForEvents.chatEventEmitter = chatEventEmitter;
    globalForEvents.appEventEmitter = appEventEmitter;
}

// Event Types
export type ChatEvent =
    | { type: 'create_conversation'; payload: { id: string; title: string; createdAt: number; messages?: Message[] } }
    | { type: 'add_message'; payload: { conversationId: string; message: Message } }
    | { type: 'context_usage'; payload: { conversationId: string; contextUsage: ContextUsageSnapshot } }
    | { type: 'delete_conversation'; payload: { id: string } }
    | { type: 'chat_stream_started'; payload: { conversationId: string; messageId: string; startedAt: number } }
    | { type: 'chat_stream_ended'; payload: { conversationId: string; messageId?: string } };

export function emitChatEvent(event: ChatEvent) {
    chatEventEmitter.emit('chat:update', event);
}

export type AppEvent =
    | { type: 'config.updated'; at: number }
    | { type: 'settings.changed'; at: number; reason?: string }
    | { type: 'inbox.changed'; at: number; conversationId?: string; action?: 'created' | 'read' | 'deleted' | 'changed' }
    | { type: 'scheduled_tasks.changed'; at: number; taskId?: string; reason?: string }
    | { type: 'task_runs.changed'; at: number; taskId?: string; runId?: string }

export type AppEventType = AppEvent['type'];
type WithOptionalAt<T extends { at: number }> = Omit<T, 'at'> & { at?: number };
export type AppEventInput = AppEvent extends infer E
    ? E extends { at: number }
        ? WithOptionalAt<E>
        : never
    : never;

export function emitAppEvent(event: AppEventInput): AppEvent {
    const next = { ...event, at: event.at ?? Date.now() } as AppEvent;
    appEventEmitter.emit('app:update', next);
    return next;
}
