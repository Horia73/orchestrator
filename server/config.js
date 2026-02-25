import fs from 'node:fs';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';

const DEFAULT_API_PORT = 8787;
const DEFAULT_MODEL = 'gemini-3-flash-preview';
const DEFAULT_THINKING_LEVEL = 'MINIMAL';
const DEFAULT_CONTEXT_MESSAGES = 120;

const VALID_THINKING_LEVELS = new Set(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH']);

function loadEnvFiles() {
    const cwd = process.cwd();
    const mode = String(process.env.NODE_ENV ?? 'development').trim() || 'development';
    const envFiles = [
        '.env',
        '.env.local',
        `.env.${mode}`,
        `.env.${mode}.local`,
    ];

    const existingKeys = new Set(Object.keys(process.env));
    const merged = {};

    for (const file of envFiles) {
        const absolutePath = path.join(cwd, file);
        if (!fs.existsSync(absolutePath)) continue;

        const fileContent = fs.readFileSync(absolutePath, 'utf8');
        const parsed = parseDotenv(fileContent);
        Object.assign(merged, parsed);
    }

    for (const [key, value] of Object.entries(merged)) {
        if (existingKeys.has(key)) continue;
        process.env[key] = value;
    }
}

function normalizeThinkingLevel(value) {
    const normalized = String(value ?? '').trim().toUpperCase();
    if (VALID_THINKING_LEVELS.has(normalized)) {
        return normalized;
    }

    return DEFAULT_THINKING_LEVEL;
}

function normalizeContextMessages(value) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
        return Math.trunc(parsed);
    }

    return DEFAULT_CONTEXT_MESSAGES;
}

loadEnvFiles();

export const API_PORT = Number(process.env.API_PORT ?? DEFAULT_API_PORT);
export const GEMINI_API_KEY = String(
    process.env.GEMINI_API_KEY ?? process.env.VITE_GEMINI_API_KEY ?? '',
).trim();
export const GEMINI_MODEL = String(process.env.GEMINI_MODEL ?? DEFAULT_MODEL).trim() || DEFAULT_MODEL;
export const GEMINI_THINKING_LEVEL = normalizeThinkingLevel(process.env.GEMINI_THINKING_LEVEL);
export const GEMINI_CONTEXT_MESSAGES = normalizeContextMessages(process.env.GEMINI_CONTEXT_MESSAGES);
