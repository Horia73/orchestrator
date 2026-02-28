import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { ORCHESTRATOR_HOME, CONFIG_PATH, DATA_ROOT_DIR } from '../core/dataPaths.js';

// ANSI color helpers (no external deps, respects NO_COLOR)
const SUPPORTS_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
export const c = {
    bold:   (s) => SUPPORTS_COLOR ? `\x1b[1m${s}\x1b[0m` : s,
    dim:    (s) => SUPPORTS_COLOR ? `\x1b[2m${s}\x1b[0m` : s,
    green:  (s) => SUPPORTS_COLOR ? `\x1b[32m${s}\x1b[0m` : s,
    yellow: (s) => SUPPORTS_COLOR ? `\x1b[33m${s}\x1b[0m` : s,
    red:    (s) => SUPPORTS_COLOR ? `\x1b[31m${s}\x1b[0m` : s,
    cyan:   (s) => SUPPORTS_COLOR ? `\x1b[36m${s}\x1b[0m` : s,
};

export function printBanner() {
    console.log('');
    console.log(c.bold('  🧠 Orchestrator'));
    console.log(c.dim('  AI assistant powered by Google Gemini'));
    console.log('');
}

export function createPrompt() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const ask = (question) => new Promise((resolve) => {
        rl.question(question, (answer) => resolve(answer.trim()));
    });

    const close = () => rl.close();

    return { ask, close };
}

export function readConfig() {
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        }
    } catch {
        // Corrupt file
    }

    return null;
}

export function writeConfig(config) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

export function ensureDataDirectories() {
    const dirs = [
        path.join(DATA_ROOT_DIR, 'chats', 'messages'),
        path.join(DATA_ROOT_DIR, 'settings'),
        path.join(DATA_ROOT_DIR, 'usage'),
        path.join(DATA_ROOT_DIR, 'logs'),
        path.join(DATA_ROOT_DIR, 'memory'),
        path.join(DATA_ROOT_DIR, 'skills'),
        path.join(DATA_ROOT_DIR, 'cron'),
    ];

    for (const dir of dirs) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

export async function validateApiKey(apiKey) {
    try {
        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
        );
        return res.ok;
    } catch {
        return false;
    }
}

export function maskApiKey(key) {
    if (!key || key.length < 12) return '(not set)';
    return key.slice(0, 8) + '...' + key.slice(-4);
}

export { ORCHESTRATOR_HOME, CONFIG_PATH, DATA_ROOT_DIR };
