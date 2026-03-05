export function createChatGenerationState() {
    const chatQueues = new Map();
    const activeGenerationsByClient = new Map();

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
            stopReason: '',
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

    function countActiveGenerationsForClient(clientId, chatId) {
        const existing = activeGenerationsByClient.get(clientId);
        if (!existing || existing.size === 0) {
            return 0;
        }

        let count = 0;
        for (const generation of existing) {
            if (chatId && generation.chatId !== chatId) {
                continue;
            }

            count += 1;
        }

        return count;
    }

    function requestStopForClient(clientId, chatId, reason = 'user_stop') {
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
                generation.stopReason = reason;
                stoppedCount += 1;
            }
        }

        return stoppedCount;
    }

    return {
        enqueueChatWork,
        registerActiveGeneration,
        unregisterActiveGeneration,
        countActiveGenerationsForClient,
        requestStopForClient,
    };
}
