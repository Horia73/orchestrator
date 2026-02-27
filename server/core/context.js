import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Context for the current generation/tool execution.
 * Contains chatId, messageId, toolCallId, clientId, etc.
 */
export const executionContext = new AsyncLocalStorage();

export function getExecutionContext() {
    return executionContext.getStore() || null;
}
