/** Skills API client */

async function parseApiResponse(response) {
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        const message = typeof payload?.error === 'string' ? payload.error : `HTTP ${response.status}`;
        throw new Error(message);
    }
    return payload;
}

export async function fetchSkills() {
    const response = await fetch('/api/skills');
    const data = await parseApiResponse(response);
    return Array.isArray(data.skills) ? data.skills : [];
}

export async function fetchSkill(name) {
    const response = await fetch(`/api/skills/${encodeURIComponent(name)}`);
    return parseApiResponse(response);
}

export async function fetchSkillResources(name) {
    const response = await fetch(`/api/skills/${encodeURIComponent(name)}/resources`);
    const data = await parseApiResponse(response);
    return Array.isArray(data.resources) ? data.resources : [];
}

export async function saveSkill(name, content) {
    const response = await fetch(`/api/skills/${encodeURIComponent(name)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
    });
    return parseApiResponse(response);
}

export async function deleteSkill(name) {
    const response = await fetch(`/api/skills/${encodeURIComponent(name)}`, {
        method: 'DELETE',
    });
    return parseApiResponse(response);
}

export async function setSkillEnabled(name, enabled) {
    const response = await fetch(`/api/skills/${encodeURIComponent(name)}/enabled`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
    });
    return parseApiResponse(response);
}
