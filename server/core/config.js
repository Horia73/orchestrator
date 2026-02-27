import fs from 'node:fs';
import path from 'node:path';
import { parse as parseDotenv } from 'dotenv';

const DEFAULT_API_PORT = 8787;
const DEFAULT_CONTEXT_MESSAGES = 120;

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
export const GEMINI_CONTEXT_MESSAGES = normalizeContextMessages(process.env.GEMINI_CONTEXT_MESSAGES);
export const TOOLS_MODEL = String(
    process.env.TOOLS_MODEL ?? process.env.GEMINI_MODEL ?? 'gemini-3-flash-preview',
).trim() || 'gemini-3-flash-preview';
