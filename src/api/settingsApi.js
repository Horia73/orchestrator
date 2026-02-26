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

export async function fetchUsage({ startDate, endDate, date } = {}) {
    const query = new URLSearchParams();
    const normalizedDate = String(date ?? '').trim();
    const normalizedStartDate = String(startDate ?? '').trim();
    const normalizedEndDate = String(endDate ?? '').trim();

    if (normalizedStartDate) {
        query.set('startDate', normalizedStartDate);
    }
    if (normalizedEndDate) {
        query.set('endDate', normalizedEndDate);
    }
    if (normalizedDate && !normalizedStartDate && !normalizedEndDate) {
        query.set('date', normalizedDate);
    }

    const queryString = query.toString();
    const response = await fetch(queryString ? `/api/usage?${queryString}` : '/api/usage');
    return parseApiResponse(response);
}

export async function fetchSystemLogs({ startDate, endDate, date, level, limit } = {}) {
    const query = new URLSearchParams();
    const normalizedDate = String(date ?? '').trim();
    const normalizedStartDate = String(startDate ?? '').trim();
    const normalizedEndDate = String(endDate ?? '').trim();
    const normalizedLevel = String(level ?? '').trim().toLowerCase();
    const normalizedLimit = Number(limit);

    if (normalizedStartDate) {
        query.set('startDate', normalizedStartDate);
    }
    if (normalizedEndDate) {
        query.set('endDate', normalizedEndDate);
    }
    if (normalizedDate && !normalizedStartDate && !normalizedEndDate) {
        query.set('date', normalizedDate);
    }
    if (normalizedLevel === 'info' || normalizedLevel === 'warn' || normalizedLevel === 'error') {
        query.set('level', normalizedLevel);
    }
    if (Number.isFinite(normalizedLimit) && normalizedLimit > 0) {
        query.set('limit', String(Math.trunc(normalizedLimit)));
    }

    const queryString = query.toString();
    const response = await fetch(queryString ? `/api/logs?${queryString}` : '/api/logs');
    return parseApiResponse(response);
}
