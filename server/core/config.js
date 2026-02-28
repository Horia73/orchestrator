import fs from 'node:fs';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { CONFIG_PATH } from './dataPaths.js';

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

loadEnvFiles();
const configJson = loadConfigJson();

export const API_PORT = Number(
    resolve(['API_PORT'], configJson?.port, DEFAULT_API_PORT),
);

export const GEMINI_API_KEY = String(
    resolve(['GEMINI_API_KEY', 'VITE_GEMINI_API_KEY'], configJson?.geminiApiKey, ''),
).trim();

export const GEMINI_CONTEXT_MESSAGES = normalizeContextMessages(
    resolve(['GEMINI_CONTEXT_MESSAGES'], configJson?.contextMessages, DEFAULT_CONTEXT_MESSAGES),
);

export const TOOLS_MODEL = String(
    resolve(['TOOLS_MODEL', 'GEMINI_MODEL'], configJson?.toolsModel, DEFAULT_TOOLS_MODEL),
).trim() || DEFAULT_TOOLS_MODEL;
