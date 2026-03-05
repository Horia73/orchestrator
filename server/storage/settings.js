/**
 * Server-side agent settings persistence.
 *
 * Settings are stored in the unified `~/.orchestrator/config.json` under the `agents` key.
 * Falls back to reading from the legacy `settings.json` if the unified config doesn't have agents yet.
 */
import {
    DEFAULT_AGENT_ID,
    createDefaultSettings,
    normalizeAgentId as normalizeRegistryAgentId,
    sanitizeAgentSettings,
} from '../agents/index.js';
import { AGENTS_CONFIG, reloadConfigJson, updateConfigSection } from '../core/config.js';

function defaultSettings() {
    return createDefaultSettings();
}

function sanitizeSettings(rawSettings) {
    return sanitizeAgentSettings(rawSettings);
}

export function normalizeAgentId(value) {
    return normalizeRegistryAgentId(value);
}

export function readSettings() {
    try {
        // Read from unified config.json `agents` section
        const config = reloadConfigJson();
        const agentsSection = config?.agents;
        if (agentsSection && typeof agentsSection === 'object') {
            return sanitizeSettings(agentsSection);
        }
    } catch {
        // Corrupt — return defaults.
    }

    return defaultSettings();
}

export function writeSettings(settings) {
    const sanitized = sanitizeSettings(settings);
    updateConfigSection('agents', sanitized);
    return sanitized;
}

/**
 * Returns the current model + generation options for a given agent.
 * Falls back to defaults if no saved setting exists.
 */
export function getAgentConfig(agentId = DEFAULT_AGENT_ID) {
    const settings = readSettings();
    const normalizedAgentId = normalizeAgentId(agentId);
    const fallback = defaultSettings();

    return settings[normalizedAgentId] ?? fallback[normalizedAgentId] ?? fallback[DEFAULT_AGENT_ID];
}

function sanitizeUiName(value, fallback) {
    const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!normalized) {
        return fallback;
    }

    return normalized.slice(0, 64);
}

function sanitizeUiEmoji(value, fallback = '🤖') {
    const normalized = String(value ?? '').trim();
    if (!normalized) {
        return fallback;
    }

    const match = normalized.match(/\p{Extended_Pictographic}/u);
    return match?.[0] ?? fallback;
}

function sanitizeUiVibe(value, fallback = 'pragmatic helper') {
    const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
    if (!normalized) {
        return fallback;
    }

    return normalized.slice(0, 140);
}

export function readUiSettings() {
    try {
        const config = reloadConfigJson();
        const uiSection = config?.ui;
        if (uiSection && typeof uiSection === 'object') {
            return {
                aiName: sanitizeUiName(uiSection.aiName, 'AI Chat'),
                userName: sanitizeUiName(uiSection.userName, 'User'),
                aiEmoji: sanitizeUiEmoji(uiSection.aiEmoji, '🤖'),
                aiVibe: sanitizeUiVibe(uiSection.aiVibe, 'pragmatic helper'),
            };
        }
    } catch {
        // ignore
    }
    return {
        aiName: 'AI Chat',
        userName: 'User',
        aiEmoji: '🤖',
        aiVibe: 'pragmatic helper',
    };
}

export function writeUiSettings(uiSettings) {
    const sanitized = {
        aiName: sanitizeUiName(uiSettings?.aiName, 'AI Chat'),
        userName: sanitizeUiName(uiSettings?.userName, 'User'),
        aiEmoji: sanitizeUiEmoji(uiSettings?.aiEmoji, '🤖'),
        aiVibe: sanitizeUiVibe(uiSettings?.aiVibe, 'pragmatic helper'),
    };
    updateConfigSection('ui', sanitized);
    return sanitized;
}
