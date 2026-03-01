async function parseApiResponse(response) {
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
        const message = typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`;
        throw new Error(message);
    }

    return payload;
}

export async function fetchChats() {
    const response = await fetch('/api/chats');
    return parseApiResponse(response);
}

export async function fetchChatMessages(chatId) {
    const response = await fetch(`/api/chats/${chatId}/messages`);
    return parseApiResponse(response);
}

export async function sendChatMessage({
    chatId,
    message,
    clientId,
    clientMessageId,
    agentId,
    attachments,
}) {
    const response = await fetch('/api/chat/send', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            chatId,
            message,
            clientId,
            clientMessageId,
            agentId,
            attachments,
        }),
    });

    return parseApiResponse(response);
}

export async function stopChatGeneration({ chatId, clientId }) {
    const response = await fetch('/api/chat/stop', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            chatId,
            clientId,
        }),
    });

    return parseApiResponse(response);
}

export async function archiveChat(chatId) {
    const response = await fetch(`/api/chats/${encodeURIComponent(chatId)}/archive`, {
        method: 'POST',
    });
    return parseApiResponse(response);
}

export async function deleteChat(chatId, clientId) {
    const response = await fetch(`/api/chats/${chatId}?clientId=${encodeURIComponent(clientId)}`, {
        method: 'DELETE',
    });

    return parseApiResponse(response);
}

export async function fetchCommandStatus({ commandId, waitSeconds = 0, chars = 12000 }) {
    const query = new URLSearchParams({
        wait: String(waitSeconds),
        chars: String(chars),
    });
    const response = await fetch(`/api/commands/${encodeURIComponent(commandId)}/status?${query.toString()}`);
    return parseApiResponse(response);
}

export async function fetchStreamingState(chatId) {
    const response = await fetch(`/api/chat/${encodeURIComponent(chatId)}/streaming-state`);
    return parseApiResponse(response);
}

export function openChatEvents(onEvent) {
    const source = new EventSource('/api/events');

    source.onmessage = (event) => {
        try {
            const payload = JSON.parse(event.data);
            onEvent(payload);
        } catch {
            // Ignore malformed event payloads.
        }
    };

    return source;
}
