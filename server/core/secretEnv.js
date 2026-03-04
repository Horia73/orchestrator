import fs from 'node:fs';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';
import { SECRETS_ENV_PATH } from './dataPaths.js';

const shellEnvKeys = new Set(Object.keys(process.env));
let loadedSecretEnv = {};

function readSecretEnvFile() {
    try {
        if (!fs.existsSync(SECRETS_ENV_PATH)) {
            return {};
        }

        const fileContent = fs.readFileSync(SECRETS_ENV_PATH, 'utf8');
        return parseDotenv(fileContent);
    } catch {
        return {};
    }
}

function serializeSecretEnvValue(value) {
    const normalized = String(value ?? '');
    if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(normalized)) {
        return normalized;
    }

    return JSON.stringify(normalized);
}

export function syncSecretEnv() {
    const next = readSecretEnvFile();

    for (const [key, previousValue] of Object.entries(loadedSecretEnv)) {
        if (shellEnvKeys.has(key)) continue;
        if (Object.prototype.hasOwnProperty.call(next, key)) continue;
        if (process.env[key] === previousValue) {
            delete process.env[key];
        }
    }

    for (const [key, value] of Object.entries(next)) {
        if (shellEnvKeys.has(key)) continue;
        process.env[key] = value;
    }

    loadedSecretEnv = next;
    return { ...loadedSecretEnv };
}

export function getSecretEnvValue(key) {
    const secrets = syncSecretEnv();
    if (!Object.prototype.hasOwnProperty.call(secrets, key)) {
        return undefined;
    }
    return secrets[key];
}

export function isShellEnvKey(key) {
    return shellEnvKeys.has(String(key ?? ''));
}

export function getSecretEnvPath() {
    return SECRETS_ENV_PATH;
}

export function upsertSecretEnvValues(updates = {}) {
    const existing = readSecretEnvFile();
    const next = { ...existing };
    const orderedKeys = [...Object.keys(existing)];

    for (const [rawKey, rawValue] of Object.entries(updates ?? {})) {
        const key = String(rawKey ?? '').trim();
        if (!key) {
            continue;
        }

        if (rawValue === undefined || rawValue === null || rawValue === '') {
            delete next[key];
            continue;
        }

        if (!orderedKeys.includes(key)) {
            orderedKeys.push(key);
        }
        next[key] = String(rawValue);
    }

    const lines = orderedKeys
        .filter((key) => Object.prototype.hasOwnProperty.call(next, key))
        .map((key) => `${key}=${serializeSecretEnvValue(next[key])}`);

    fs.mkdirSync(path.dirname(SECRETS_ENV_PATH), { recursive: true });
    fs.writeFileSync(SECRETS_ENV_PATH, `${lines.join('\n')}\n`, 'utf8');
    return syncSecretEnv();
}

syncSecretEnv();
