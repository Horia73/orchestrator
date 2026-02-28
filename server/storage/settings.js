/**
 * Server-side settings persistence.
 *
 * Stored as JSON in `server/data/settings/settings.json`.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
    DEFAULT_AGENT_ID,
    createDefaultSettings,
    normalizeAgentId as normalizeRegistryAgentId,
    sanitizeAgentSettings,
} from '../agents/index.js';
import { SETTINGS_PATH } from '../core/dataPaths.js';

function defaultSettings() {
    return createDefaultSettings();
}

function sanitizeSettings(rawSettings) {
    return sanitizeAgentSettings(rawSettings);
}

function ensureSettingsDir() {
    const dir = path.dirname(SETTINGS_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

export function normalizeAgentId(value) {
    return normalizeRegistryAgentId(value);
}

export function readSettings() {
    try {
        if (fs.existsSync(SETTINGS_PATH)) {
            const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
            const parsed = JSON.parse(raw);
            return sanitizeSettings(parsed);
        }
    } catch {
        // Corrupt or missing — return defaults.
    }

    return defaultSettings();
}

export function writeSettings(settings) {
    ensureSettingsDir();

    const sanitized = sanitizeSettings(settings);
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(sanitized, null, 2), 'utf8');
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
