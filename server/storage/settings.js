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
