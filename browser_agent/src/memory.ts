/**
 * Memory System - Persistent learnings from mistakes
 * Stores memory in a human-readable Markdown file with legacy JSON migration.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MEMORY_MARKDOWN_FILE = path.join(__dirname, '..', 'MEMORY.md');
const LEGACY_MEMORY_JSON_FILE = path.join(__dirname, '..', 'memory.json');
const MAX_LEARNINGS = 20;
const MAX_PROMPT_LEARNINGS = 10;

export interface Learning {
    id: string;
    lesson: string;
    context: string;
    createdAt: string;
    useCount: number;
}

export interface Memory {
    learnings: Learning[];
}

function normalizeWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

function sanitizeLesson(value: string | undefined): string {
    if (!value) {
        return '';
    }
    return normalizeWhitespace(value);
}

function sanitizeContext(value: string | undefined): string {
    if (!value) {
        return 'general';
    }
    return normalizeWhitespace(value) || 'general';
}

function sanitizeCreatedAt(value: string | undefined): string {
    if (!value) {
        return new Date().toISOString();
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        return new Date().toISOString();
    }

    return parsed.toISOString();
}

function sanitizeUseCount(value: number | string | undefined): number {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return 1;
    }
    return Math.floor(numeric);
}

function sanitizeLearning(raw: Partial<Learning>, fallbackId: string): Learning {
    return {
        id: raw.id?.trim() || fallbackId,
        lesson: sanitizeLesson(raw.lesson),
        context: sanitizeContext(raw.context),
        createdAt: sanitizeCreatedAt(raw.createdAt),
        useCount: sanitizeUseCount(raw.useCount),
    };
}

function normalizeMemory(memory: Memory): Memory {
    return {
        learnings: memory.learnings
            .map((learning, index) => sanitizeLearning(learning, `${Date.now()}-${index + 1}`))
            .filter((learning) => learning.lesson.length > 0),
    };
}

function loadLegacyJsonMemory(): Memory | null {
    if (!fs.existsSync(LEGACY_MEMORY_JSON_FILE)) {
        return null;
    }

    try {
        const raw = fs.readFileSync(LEGACY_MEMORY_JSON_FILE, 'utf8');
        const parsed = JSON.parse(raw) as Memory;
        if (!parsed || !Array.isArray(parsed.learnings)) {
            return null;
        }
        return normalizeMemory(parsed);
    } catch {
        return null;
    }
}

function parseMarkdownMemory(markdown: string): Memory {
    const learnings: Learning[] = [];
    const lines = markdown.split(/\r?\n/);

    let current: Partial<Learning> = {};
    let counter = 0;

    const pushCurrent = () => {
        if (!current.lesson) {
            current = {};
            return;
        }
        counter += 1;
        learnings.push(sanitizeLearning(current, `${Date.now()}-${counter}`));
        current = {};
    };

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
            continue;
        }

        const headingMatch = line.match(/^###\s+(.+)$/);
        if (headingMatch) {
            pushCurrent();
            current.lesson = headingMatch[1].replace(/^\d+\.\s*/, '').trim();
            continue;
        }

        const idMatch = line.match(/^- `id`:\s*(.+)$/i);
        if (idMatch) {
            current.id = idMatch[1].trim();
            continue;
        }

        const contextMatch = line.match(/^- `context`:\s*(.+)$/i);
        if (contextMatch) {
            current.context = contextMatch[1].trim();
            continue;
        }

        const createdAtMatch = line.match(/^- `first_seen`:\s*(.+)$/i);
        if (createdAtMatch) {
            current.createdAt = createdAtMatch[1].trim();
            continue;
        }

        const useCountMatch = line.match(/^- `reinforced`:\s*(\d+)\s*$/i);
        if (useCountMatch) {
            current.useCount = Number(useCountMatch[1]);
            continue;
        }
    }

    pushCurrent();

    const parsed = normalizeMemory({ learnings });
    if (parsed.learnings.length > 0) {
        return parsed;
    }

    // Fallback parser for manually curated bullet lists under "Learned Rules"
    const sectionMatch = markdown.match(/##\s+Learned Rules([\s\S]*?)(?:\n##\s+|$)/i);
    if (!sectionMatch) {
        return { learnings: [] };
    }

    const bullets = sectionMatch[1]
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^[-*]\s+/.test(line))
        .map((line) => line.replace(/^[-*]\s+/, '').trim())
        .filter((line) => line && !line.startsWith('`') && !line.startsWith('_'));

    const fallbackLearnings = bullets.map((lesson, index) =>
        sanitizeLearning(
            {
                lesson,
                context: 'general',
                createdAt: new Date().toISOString(),
                useCount: 1,
            },
            `${Date.now()}-${index + 1}`
        )
    );

    return normalizeMemory({ learnings: fallbackLearnings });
}

function formatLearningsForMarkdown(learnings: Learning[]): string {
    if (learnings.length === 0) {
        return '_No learnings saved yet._';
    }

    return learnings
        .map((learning, index) => {
            return [
                `### ${index + 1}. ${learning.lesson}`,
                `- \`id\`: ${learning.id}`,
                `- \`context\`: ${learning.context}`,
                `- \`first_seen\`: ${learning.createdAt}`,
                `- \`reinforced\`: ${learning.useCount}`,
                '',
            ].join('\n');
        })
        .join('\n')
        .trimEnd();
}

function toMarkdown(memory: Memory): string {
    const prioritized = [...memory.learnings].sort((a, b) => {
        if (b.useCount !== a.useCount) {
            return b.useCount - a.useCount;
        }
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    const learnedRules = formatLearningsForMarkdown(prioritized);

    return `# Browser Agent Memory

This file stores persistent lessons learned by the browser agent.
It is designed to be human-readable and easy for an LLM to follow.

## Working Rules
- Keep lessons specific, actionable, and reusable.
- Keep only high-signal learnings that reduce repeated mistakes.
- Prefer behavior-level guidance over one-off observations.

## Learned Rules
${learnedRules}
`;
}

function saveMemory(memory: Memory): void {
    try {
        const normalized = normalizeMemory(memory);
        fs.writeFileSync(MEMORY_MARKDOWN_FILE, toMarkdown(normalized), 'utf8');
    } catch {
        console.log('⚠️ Could not save memory');
    }
}

function loadMemory(): Memory {
    try {
        if (fs.existsSync(MEMORY_MARKDOWN_FILE)) {
            const markdown = fs.readFileSync(MEMORY_MARKDOWN_FILE, 'utf8');
            const parsed = normalizeMemory(parseMarkdownMemory(markdown));
            if (parsed.learnings.length > 0) {
                return parsed;
            }

            const legacyFromEmptyMarkdown = loadLegacyJsonMemory();
            if (legacyFromEmptyMarkdown && legacyFromEmptyMarkdown.learnings.length > 0) {
                saveMemory(legacyFromEmptyMarkdown);
                console.log('🧠 Migrated legacy memory.json to MEMORY.md');
                return legacyFromEmptyMarkdown;
            }

            return parsed;
        }
    } catch {
        console.log('⚠️ Could not load MEMORY.md, trying legacy JSON');
    }

    const legacy = loadLegacyJsonMemory();
    if (legacy) {
        saveMemory(legacy);
        console.log('🧠 Migrated legacy memory.json to MEMORY.md');
        return legacy;
    }

    return { learnings: [] };
}

function areSimilarLessons(a: string, b: string): boolean {
    const first = sanitizeLesson(a).toLowerCase();
    const second = sanitizeLesson(b).toLowerCase();

    if (!first || !second) {
        return false;
    }
    if (first === second) {
        return true;
    }

    const prefixLength = Math.min(40, first.length, second.length);
    if (prefixLength >= 20 && first.slice(0, prefixLength) === second.slice(0, prefixLength)) {
        return true;
    }

    return first.includes(second) || second.includes(first);
}

export function addLearning(lesson: string, context: string): void {
    const cleanedLesson = sanitizeLesson(lesson);
    if (!cleanedLesson) {
        return;
    }

    const memory = loadMemory();
    const existing = memory.learnings.find((item) => areSimilarLessons(item.lesson, cleanedLesson));

    if (existing) {
        existing.useCount = sanitizeUseCount(existing.useCount + 1);
        if (existing.context === 'general' && sanitizeContext(context) !== 'general') {
            existing.context = sanitizeContext(context);
        }
        saveMemory(memory);
        return;
    }

    memory.learnings.push({
        id: Date.now().toString(),
        lesson: cleanedLesson,
        context: sanitizeContext(context),
        createdAt: new Date().toISOString(),
        useCount: 1,
    });

    // Keep only the newest MAX_LEARNINGS entries.
    if (memory.learnings.length > MAX_LEARNINGS) {
        memory.learnings = [...memory.learnings]
            .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
            .slice(-MAX_LEARNINGS);
    }

    saveMemory(memory);
    console.log(`💡 Learned: ${cleanedLesson}`);
}

export function getLearnings(): string[] {
    const memory = loadMemory();
    return [...memory.learnings]
        .sort((a, b) => {
            if (b.useCount !== a.useCount) {
                return b.useCount - a.useCount;
            }
            return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
        })
        .slice(0, MAX_PROMPT_LEARNINGS)
        .map((learning) => learning.lesson);
}

export function clearLearnings(): void {
    saveMemory({ learnings: [] });
}

export function initializeDefaultLearnings(): void {
    // Ensure the memory file exists and perform legacy migration when needed.
    const memory = loadMemory();
    saveMemory(memory);
}
