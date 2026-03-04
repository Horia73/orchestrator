import fs from 'node:fs';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { CONFIG_PATH } from './dataPaths.js';
import { getSecretEnvValue, isShellEnvKey, syncSecretEnv, upsertSecretEnvValues } from './secretEnv.js';

const DEFAULT_API_PORT = 8787;
const DEFAULT_CONTEXT_MESSAGES = 120;
const DEFAULT_TOOLS_MODEL = 'gemini-3-flash-preview';

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
    syncSecretEnv();

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
        if (process.env[key] !== undefined && (isShellEnvKey(key) || getSecretEnvValue(key) !== undefined)) {
            continue;
        }
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

function hydrateGeminiApiKeyEnv(configJsonValue) {
    const shellKey = String(process.env.GEMINI_API_KEY ?? process.env.VITE_GEMINI_API_KEY ?? '').trim();
    if (shellKey) {
        process.env.GEMINI_API_KEY = shellKey;
        return shellKey;
    }

    const secretKey = String(
        getSecretEnvValue('GEMINI_API_KEY')
        ?? getSecretEnvValue('VITE_GEMINI_API_KEY')
        ?? '',
    ).trim();
    if (secretKey) {
        process.env.GEMINI_API_KEY = secretKey;
        return secretKey;
    }

    const configKey = String(configJsonValue ?? '').trim();
    if (configKey) {
        process.env.GEMINI_API_KEY = configKey;
        return configKey;
    }

    return '';
}

function migrateSecretsIfNeeded(configJson) {
    if (!configJson || typeof configJson !== 'object') {
        return configJson;
    }

    const geminiApiKey = String(configJson?.geminiApiKey ?? '').trim();
    if (!geminiApiKey) {
        hydrateGeminiApiKeyEnv('');
        return configJson;
    }

    upsertSecretEnvValues({
        GEMINI_API_KEY: geminiApiKey,
    });
    hydrateGeminiApiKeyEnv(geminiApiKey);

    delete configJson.geminiApiKey;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(configJson, null, 2) + '\n', 'utf8');

    return configJson;
}

// Resolve a config value with correct precedence:
// 1. Shell env var
// 2. Secret env store (~/.orchestrator/data/secrets/SECRETS.env)
// 3. config.json value
// 4. Project .env file value
// 5. default
function resolve(envKeys, configValue, fallback) {
    for (const key of envKeys) {
        if (isShellEnvKey(key) && process.env[key] !== undefined) {
            return process.env[key];
        }
    }

    for (const key of envKeys) {
        const secretValue = getSecretEnvValue(key);
        if (secretValue !== undefined) {
            return secretValue;
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

    try {
        // Migrate flat `contextMessages` → nested `context.messages`
        if (configJson.contextMessages !== undefined && !configJson.context) {
            configJson.context = { messages: configJson.contextMessages };

            // Write the config
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(configJson, null, 2) + '\n', 'utf8');
        }
    } catch {
        // Migration failed — continue with what we have
    }

    return configJson;
}

loadEnvFiles();
const rawConfigJson = loadConfigJson();
const configJson = migrateSecretsIfNeeded(migrateIfNeeded(rawConfigJson));
hydrateGeminiApiKeyEnv(configJson?.geminiApiKey);

export const API_PORT = Number(
    resolve(['API_PORT'], configJson?.port, DEFAULT_API_PORT),
);

// Support both flat `contextMessages` and nested `context.messages`
export function getGeminiContextMessages() {
    const fresh = reloadConfigJson();
    const contextValue = fresh?.context?.messages ?? fresh?.contextMessages;
    return normalizeContextMessages(
        resolve(['GEMINI_CONTEXT_MESSAGES'], contextValue, DEFAULT_CONTEXT_MESSAGES),
    );
}

export function getGeminiApiKey() {
    syncSecretEnv();
    const resolved = String(
        resolve(['GEMINI_API_KEY', 'VITE_GEMINI_API_KEY'], reloadConfigJson()?.geminiApiKey, ''),
    ).trim();
    if (resolved) {
        process.env.GEMINI_API_KEY = resolved;
    }
    return resolved;
}

export function getToolsModel() {
    return String(
        resolve(['TOOLS_MODEL', 'GEMINI_MODEL'], reloadConfigJson()?.toolsModel, DEFAULT_TOOLS_MODEL),
    ).trim() || DEFAULT_TOOLS_MODEL;
}

// Agent settings from unified config
export const AGENTS_CONFIG = configJson?.agents ?? {};

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
