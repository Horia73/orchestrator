/**
 * Server-side settings persistence.
 *
 * Stored as JSON in `server/data/settings.json`.
 * Shape: { orchestrator: { model, thinkingLevel }, ... }
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GEMINI_MODEL, GEMINI_THINKING_LEVEL } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_PATH = path.join(__dirname, 'data', 'settings.json');

function defaultSettings() {
    return {
        orchestrator: {
            model: GEMINI_MODEL,
            thinkingLevel: GEMINI_THINKING_LEVEL,
        },
    };
}

export function readSettings() {
    try {
        if (fs.existsSync(SETTINGS_PATH)) {
            const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
            return JSON.parse(raw);
        }
    } catch {
        // corrupt or missing — return defaults
    }
    return defaultSettings();
}

export function writeSettings(settings) {
    const dir = path.dirname(SETTINGS_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
}

/**
 * Returns the current active model & thinking level for a given agent.
 * Falls back to config.js defaults if no saved setting exists.
 */
export function getAgentConfig(agentId = 'orchestrator') {
    const settings = readSettings();
    const agent = settings[agentId];
    return {
        model: agent?.model ?? GEMINI_MODEL,
        thinkingLevel: agent?.thinkingLevel ?? GEMINI_THINKING_LEVEL,
    };
}
