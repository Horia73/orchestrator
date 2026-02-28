/**
 * Two-layer memory system:
 * - MEMORY.md: long-term facts, always injected into system prompt
 * - HISTORY.md: timestamped event log, grep-searchable
 *
 * Consolidation runs automatically when the message window fills up.
 * Uses a Gemini function-call to extract structured memory from old messages.
 */
import fs from 'node:fs';
import { GoogleGenAI } from '@google/genai';
import { GEMINI_API_KEY, MEMORY_CONFIG } from '../core/config.js';
import { MEMORY_DIR, MEMORY_PATH, HISTORY_PATH } from '../core/dataPaths.js';

function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

// ─── Save Memory Tool Definition (for consolidation agent) ──────────────────

const SAVE_MEMORY_TOOL = [{
    functionDeclarations: [{
        name: 'save_memory',
        description: 'Save the memory consolidation result to persistent storage.',
        parameters: {
            type: 'OBJECT',
            properties: {
                history_entry: {
                    type: 'STRING',
                    description: 'A paragraph (2-5 sentences) summarizing key events/decisions/topics. Start with [YYYY-MM-DD HH:MM]. Include detail useful for grep search.',
                },
                memory_update: {
                    type: 'STRING',
                    description: 'Full updated long-term memory as markdown. Include all existing facts plus new ones. Return unchanged if nothing new.',
                },
            },
            required: ['history_entry', 'memory_update'],
        },
    }],
}];

// ─── MemoryStore ────────────────────────────────────────────────────────────

class MemoryStore {
    constructor() {
        this.memoryDir = MEMORY_DIR;
        this.memoryFile = MEMORY_PATH;
        this.historyFile = HISTORY_PATH;
        this._consolidating = false;
    }

    readLongTerm() {
        try {
            if (fs.existsSync(this.memoryFile)) {
                return fs.readFileSync(this.memoryFile, 'utf8');
            }
        } catch {
            // ignore
        }
        return '';
    }

    writeLongTerm(content) {
        ensureDir(this.memoryDir);
        fs.writeFileSync(this.memoryFile, content, 'utf8');
    }

    readHistory() {
        try {
            if (fs.existsSync(this.historyFile)) {
                return fs.readFileSync(this.historyFile, 'utf8');
            }
        } catch {
            // ignore
        }
        return '';
    }

    appendHistory(entry) {
        ensureDir(this.memoryDir);
        fs.appendFileSync(this.historyFile, entry.trimEnd() + '\n\n', 'utf8');
    }

    getMemoryContext() {
        const longTerm = this.readLongTerm();
        if (!longTerm) return '';
        return `\n\n<long_term_memory>\n${longTerm}\n</long_term_memory>`;
    }

    clearAll() {
        try {
            if (fs.existsSync(this.memoryFile)) fs.unlinkSync(this.memoryFile);
            if (fs.existsSync(this.historyFile)) fs.unlinkSync(this.historyFile);
        } catch {
            // ignore
        }
    }

    /**
     * Consolidate old messages into MEMORY.md + HISTORY.md via LLM tool call.
     * @param {Array} messages - Messages to consolidate (array of {role, text, createdAt})
     * @returns {boolean} True on success
     */
    async consolidate(messages) {
        if (this._consolidating) return false;
        if (!MEMORY_CONFIG.enabled) return false;
        if (!messages || messages.length === 0) return true;

        this._consolidating = true;
        try {
            const lines = messages.map((m) => {
                const ts = m.createdAt ? new Date(m.createdAt).toISOString().slice(0, 16) : '?';
                const role = String(m.role ?? 'user').toUpperCase();
                const text = String(m.text ?? '').slice(0, 2000);
                return `[${ts}] ${role}: ${text}`;
            });

            const currentMemory = this.readLongTerm();
            const prompt = `Process this conversation and call the save_memory tool with your consolidation.

## Current Long-term Memory
${currentMemory || '(empty)'}

## Conversation to Process
${lines.join('\n')}`;

            const client = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

            const response = await client.models.generateContent({
                model: MEMORY_CONFIG.consolidationModel,
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                config: {
                    systemInstruction: 'You are a memory consolidation agent. Call the save_memory tool with your consolidation of the conversation. Extract key facts, decisions, user preferences, and important context.',
                    tools: SAVE_MEMORY_TOOL,
                },
            });

            // Extract tool call from response
            const parts = response?.candidates?.[0]?.content?.parts ?? [];
            const toolCall = parts.find((p) => p.functionCall?.name === 'save_memory');

            if (!toolCall) {
                console.warn('[memory] Consolidation: LLM did not call save_memory');
                return false;
            }

            const args = toolCall.functionCall.args;
            if (!args || typeof args !== 'object') {
                console.warn('[memory] Consolidation: unexpected arguments');
                return false;
            }

            if (args.history_entry) {
                const entry = typeof args.history_entry === 'string'
                    ? args.history_entry
                    : JSON.stringify(args.history_entry);
                this.appendHistory(entry);
            }

            if (args.memory_update) {
                const update = typeof args.memory_update === 'string'
                    ? args.memory_update
                    : JSON.stringify(args.memory_update);
                if (update !== currentMemory) {
                    this.writeLongTerm(update);
                }
            }

            console.log(`[memory] Consolidation complete: ${messages.length} messages processed`);
            return true;
        } catch (error) {
            console.error('[memory] Consolidation failed:', error?.message ?? error);
            return false;
        } finally {
            this._consolidating = false;
        }
    }

    get isConsolidating() {
        return this._consolidating;
    }
}

// Singleton
export const memoryStore = new MemoryStore();
