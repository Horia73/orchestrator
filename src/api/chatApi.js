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
    isSteering,
    replyTo,
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
            isSteering,
            replyTo,
        }),
    });

    return parseApiResponse(response);
}

export async function uploadChatAttachment(file, { name, mimeType } = {}) {
    const uploadName = String(name ?? file?.name ?? 'attachment').trim() || 'attachment';
    const uploadMimeType = String(mimeType ?? file?.type ?? '').trim() || 'application/octet-stream';

    const response = await fetch('/api/uploads', {
        method: 'POST',
        headers: {
            'Content-Type': uploadMimeType,
            'X-Upload-Name': encodeURIComponent(uploadName),
            'X-Upload-Mime-Type': encodeURIComponent(uploadMimeType),
        },
        body: file,
    });

    return parseApiResponse(response);
}

export async function deleteChatAttachmentUpload(uploadId) {
    const response = await fetch(`/api/uploads/${encodeURIComponent(uploadId)}`, {
        method: 'DELETE',
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

export async function deleteChat(chatId, clientId) {
    const response = await fetch(`/api/chats/${chatId}?clientId=${encodeURIComponent(clientId)}`, {
        method: 'DELETE',
    });

    return parseApiResponse(response);
}

export async function clearChatMessages(chatId, clientId) {
    const response = await fetch(`/api/chats/${chatId}/messages?clientId=${encodeURIComponent(clientId)}`, {
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

export function getBrowserAgentLiveStreamUrl({ sessionId, chatId }) {
    const normalizedSessionId = String(sessionId ?? '').trim();
    const normalizedChatId = String(chatId ?? '').trim();
    const query = new URLSearchParams();
    query.set('chatId', normalizedChatId);
    return `/api/browser-agent/sessions/${encodeURIComponent(normalizedSessionId)}/live.mjpeg?${query.toString()}`;
}

export async function fetchBrowserAgentSession({ sessionId, chatId }) {
    const query = new URLSearchParams();
    query.set('chatId', String(chatId ?? '').trim());
    const response = await fetch(`/api/browser-agent/sessions/${encodeURIComponent(String(sessionId ?? '').trim())}?${query.toString()}`);
    return parseApiResponse(response);
}

export async function fetchBrowserAgentRecording({ sessionId, chatId, limit = 120 }) {
    const query = new URLSearchParams();
    query.set('chatId', String(chatId ?? '').trim());
    query.set('limit', String(limit));
    const response = await fetch(`/api/browser-agent/sessions/${encodeURIComponent(String(sessionId ?? '').trim())}/recording?${query.toString()}`);
    return parseApiResponse(response);
}

export function getBrowserAgentRecordingVideoUrl({ sessionId, chatId, index = 0, download = false }) {
    const query = new URLSearchParams();
    query.set('chatId', String(chatId ?? '').trim());
    if (Number.isFinite(Number(index)) && Number(index) > 0) {
        query.set('index', String(Math.trunc(Number(index))));
    }
    if (download) {
        query.set('download', '1');
    }
    return `/api/browser-agent/sessions/${encodeURIComponent(String(sessionId ?? '').trim())}/recording/video?${query.toString()}`;
}

export function getBrowserAgentRemoteDesktopWsUrl({ sessionId, chatId }) {
    const query = new URLSearchParams();
    query.set('chatId', String(chatId ?? '').trim());
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const path = `/api/browser-agent/sessions/${encodeURIComponent(String(sessionId ?? '').trim())}/vnc/ws?${query.toString()}`;
    return `${protocol}//${window.location.host}${path}`;
}

export async function controlBrowserAgentSession({
    sessionId,
    chatId,
    action,
    x,
    y,
    text,
    key,
    url,
    durationMs,
}) {
    const response = await fetch(`/api/browser-agent/sessions/${encodeURIComponent(String(sessionId ?? '').trim())}/control`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            chatId,
            action,
            x,
            y,
            text,
            key,
            url,
            durationMs,
        }),
    });
    return parseApiResponse(response);
}

export async function continueBrowserAgentSessionRequest({
    sessionId,
    chatId,
    clientId,
    note,
}) {
    const response = await fetch(`/api/browser-agent/sessions/${encodeURIComponent(String(sessionId ?? '').trim())}/continue`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            chatId,
            clientId,
            note,
        }),
    });
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
