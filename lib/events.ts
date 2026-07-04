import { EventEmitter } from 'events';
import type { ContextUsageSnapshot, Message } from '@/lib/types';
import { getActiveProfileId } from '@/lib/profiles/context';

// The emitters must be process-wide singletons registered on globalThis, in
// production too — not only across dev fast-refresh. Next compiles the
// instrumentation graph (voice gateway, scheduler boot wiring) separately
// from the route-handler graph, so module-level instances can exist twice in
// the same process; an event emitted by the voice gateway's copy would never
// reach /api/sync listeners created by the routes' copy (conversations then
// appear only after a refresh).
const globalForEvents = globalThis as unknown as {
    chatEventEmitter?: EventEmitter;
    appEventEmitter?: EventEmitter;
};

export const chatEventEmitter = (globalForEvents.chatEventEmitter ??= new EventEmitter());
export const appEventEmitter = (globalForEvents.appEventEmitter ??= new EventEmitter());

// Increase max listeners if you expect many simultaneous connections
chatEventEmitter.setMaxListeners(100);
appEventEmitter.setMaxListeners(100);

// Event Types
type ChatEventBase =
    | { type: 'create_conversation'; payload: { id: string; title: string; createdAt: number; updatedAt?: number; messages?: Message[]; messageCount?: number; lastMessagePreview?: string; lastMessageAt?: number; readAt?: number | null; archivedAt?: number | null } }
    | { type: 'add_message'; payload: { conversationId: string; message: Message } }
    | { type: 'context_usage'; payload: { conversationId: string; contextUsage: ContextUsageSnapshot } }
    | { type: 'conversation_read_state'; payload: { conversationId: string; readAt: number | null } }
    | { type: 'conversation_archive_state'; payload: { conversationId: string; archivedAt: number | null } }
    | { type: 'conversation_title'; payload: { conversationId: string; title: string } }
    | { type: 'delete_conversation'; payload: { id: string } }
    | { type: 'chat_stream_started'; payload: { conversationId: string; messageId: string; startedAt: number } }
    | { type: 'chat_stream_ended'; payload: { conversationId: string; messageId?: string } }
    // Steering: a follow-up sent while a turn was streaming got queued /
    // claimed for the next turn / dropped (user pressed Stop).
    | { type: 'chat_followup_queued'; payload: { conversationId: string; followUpId: string; userMessageId: string; source: 'user' | 'background-job' } }
    | { type: 'chat_followup_claimed'; payload: { conversationId: string; followUpId: string; userMessageId: string } }
    | { type: 'chat_followups_cleared'; payload: { conversationId: string } };

export type ChatEvent = ChatEventBase & { profileId?: string };

export function emitChatEvent(event: ChatEvent) {
    chatEventEmitter.emit('chat:update', { ...event, profileId: event.profileId ?? getActiveProfileId() });
}

type AppEventBase =
    | { type: 'config.updated'; at: number }
    | { type: 'settings.changed'; at: number; reason?: string }
    | { type: 'inbox.changed'; at: number; conversationId?: string; action?: 'created' | 'read' | 'deleted' | 'changed' }
    | { type: 'artifacts.changed'; at: number; conversationId?: string; messageId?: string; artifactId?: string; action?: 'created' | 'deleted' | 'changed' }
    | { type: 'scheduled_tasks.changed'; at: number; taskId?: string; reason?: string }
    | { type: 'task_runs.changed'; at: number; taskId?: string; runId?: string }
    // Smart Monitor — fired when a watch is created/updated/deleted/state-changed.
    | { type: 'monitor_watches.changed'; at: number; watchId?: string; reason?: string }
    // Fired when a watch records an event (check/match/wake/notify/action/error/...).
    | { type: 'monitor_watch_events.changed'; at: number; watchId?: string; eventId?: string }
    // Microscripts lifecycle/run changes.
    | { type: 'microscripts.changed'; at: number; scriptId?: string; reason?: string }
    | { type: 'microscript_runs.changed'; at: number; scriptId?: string; runId?: string }
    // Inbound webhooks lifecycle and dispatch history.
    | { type: 'webhooks.changed'; at: number; endpointId?: string; reason?: string }
    | { type: 'webhook_events.changed'; at: number; endpointId?: string; eventId?: string }
    // Internal apps registry (saved reusable mini-apps) and their data docs.
    | { type: 'apps.changed'; at: number; appId?: string; action?: 'created' | 'updated' | 'deleted' }
    | { type: 'app_data.changed'; at: number; appId: string }

export type AppEvent = AppEventBase & { profileId?: string }

export type AppEventType = AppEvent['type'];
type WithOptionalAt<T extends { at: number }> = Omit<T, 'at'> & { at?: number };
export type AppEventInput = AppEvent extends infer E
    ? E extends { at: number }
        ? WithOptionalAt<E>
        : never
    : never;

export function emitAppEvent(event: AppEventInput): AppEvent {
    const next = { ...event, at: event.at ?? Date.now(), profileId: event.profileId ?? getActiveProfileId() } as AppEvent;
    appEventEmitter.emit('app:update', next);
    return next;
}
