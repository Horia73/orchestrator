import fs from 'node:fs';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { CONFIG_PATH, SETTINGS_PATH } from './dataPaths.js';

const DEFAULT_API_PORT = 8787;
const DEFAULT_CONTEXT_MESSAGES = 120;
const DEFAULT_TOOLS_MODEL = 'gemini-3-flash-preview';

// Capture keys that were already in the shell BEFORE .env loading
const shellEnvKeys = new Set(Object.keys(process.env));

function loadConfigJson() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
            return JSON.parse(raw);
        }
    } catch {
        // Corrupt or missing — fall through.
    }

    return null;
}

function loadEnvFiles() {
    const cwd = process.cwd();
    const mode = String(process.env.NODE_ENV ?? 'development').trim() || 'development';
    const envFiles = [
        '.env',
        '.env.local',
        `.env.${mode}`,
        `.env.${mode}.local`,
    ];

    const merged = {};

    for (const file of envFiles) {
        const absolutePath = path.join(cwd, file);
        if (!fs.existsSync(absolutePath)) continue;

        const fileContent = fs.readFileSync(absolutePath, 'utf8');
        const parsed = parseDotenv(fileContent);
        Object.assign(merged, parsed);
    }

    for (const [key, value] of Object.entries(merged)) {
        if (shellEnvKeys.has(key)) continue;
        process.env[key] = value;
    }
}

function normalizeContextMessages(value) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
        return Math.trunc(parsed);
    }

    return DEFAULT_CONTEXT_MESSAGES;
}

// Resolve a config value with correct precedence:
// 1. Shell env var (existed before .env loading)
// 2. config.json value
// 3. .env file value (loaded into process.env)
// 4. default
function resolve(envKeys, configValue, fallback) {
    for (const key of envKeys) {
        if (shellEnvKeys.has(key) && process.env[key] !== undefined) {
            return process.env[key];
        }
    }

    if (configValue !== undefined && configValue !== null) {
        return configValue;
    }

    for (const key of envKeys) {
        if (process.env[key] !== undefined) {
            return process.env[key];
        }
    }

    return fallback;
}

/**
 * Migrate old split config (config.json + settings.json) into unified config.json.
 * Called once at load time. If config.json has no `agents` key but settings.json exists,
 * merge them and write back.
 */
function migrateIfNeeded(configJson) {
    if (!configJson) return configJson;
    if (configJson.agents) return configJson; // already unified

    try {
        if (!fs.existsSync(SETTINGS_PATH)) return configJson;
        const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
        const settings = JSON.parse(raw);
        if (!settings || typeof settings !== 'object') return configJson;

        // Merge settings into config under `agents`
        configJson.agents = settings;

        // Also migrate flat `contextMessages` → nested `context.messages`
        if (configJson.contextMessages !== undefined && !configJson.context) {
            configJson.context = { messages: configJson.contextMessages };
        }

        // Write the unified config
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(configJson, null, 2) + '\n', 'utf8');

        // Rename old settings.json so it's not re-migrated
        const backupPath = SETTINGS_PATH + '.bak';
        fs.renameSync(SETTINGS_PATH, backupPath);

        console.log('[config] Migrated settings.json into unified config.json');
    } catch {
        // Migration failed — continue with what we have
    }

    return configJson;
}

loadEnvFiles();
const rawConfigJson = loadConfigJson();
const configJson = migrateIfNeeded(rawConfigJson);

export const API_PORT = Number(
    resolve(['API_PORT'], configJson?.port, DEFAULT_API_PORT),
);

export const GEMINI_API_KEY = String(
    resolve(['GEMINI_API_KEY', 'VITE_GEMINI_API_KEY'], configJson?.geminiApiKey, ''),
).trim();

// Support both flat `contextMessages` and nested `context.messages`
const contextMessagesValue = configJson?.context?.messages ?? configJson?.contextMessages;
export const GEMINI_CONTEXT_MESSAGES = normalizeContextMessages(
    resolve(['GEMINI_CONTEXT_MESSAGES'], contextMessagesValue, DEFAULT_CONTEXT_MESSAGES),
);

export const TOOLS_MODEL = String(
    resolve(['TOOLS_MODEL', 'GEMINI_MODEL'], configJson?.toolsModel, DEFAULT_TOOLS_MODEL),
).trim() || DEFAULT_TOOLS_MODEL;

// Agent settings from unified config
export const AGENTS_CONFIG = configJson?.agents ?? {};

// Memory config
const DEFAULT_MEMORY_CONFIG = {
    enabled: true,
    consolidationModel: 'gemini-3-flash-preview',
    window: 100,
};

export const MEMORY_CONFIG = {
    enabled: configJson?.memory?.enabled !== false,
    consolidationModel: String(configJson?.memory?.consolidationModel ?? DEFAULT_MEMORY_CONFIG.consolidationModel).trim() || DEFAULT_MEMORY_CONFIG.consolidationModel,
    window: Number(configJson?.memory?.window) || DEFAULT_MEMORY_CONFIG.window,
};

// Cron config
export const CRON_CONFIG = {
    enabled: configJson?.cron?.enabled !== false,
};

/**
 * Re-read config.json from disk (for runtime updates).
 */
export function reloadConfigJson() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        }
    } catch {
        // ignore
    }
    return null;
}

/**
 * Write a section back to config.json, merging with existing.
 */
export function updateConfigSection(section, value) {
    const current = reloadConfigJson() ?? {};
    current[section] = value;
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2) + '\n', 'utf8');
    return current;
}
