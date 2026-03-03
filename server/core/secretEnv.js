import fs from 'node:fs';
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

syncSecretEnv();
