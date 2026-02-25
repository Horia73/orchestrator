/** Settings API client */

async function parseApiResponse(response) {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        const message = typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`;
        throw new Error(message);
    }
    return payload;
}

export async function fetchSettings() {
    const response = await fetch('/api/settings');
    const data = await parseApiResponse(response);
    return data.settings;
}

export async function saveSettings(settings) {
    const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings }),
    });
    return parseApiResponse(response);
}

export async function fetchRemoteModels() {
    const response = await fetch('/api/models');
    const data = await parseApiResponse(response);
    return data.models;
}
