import fs from 'node:fs';
import path from 'node:path';
import { memoryStore } from '../../services/memory.js';

const MEMORY_MARKDOWN_FILE = memoryStore.getAgentMemoryFilePath('browser');
const MAX_LEARNINGS = 20;
const MAX_PROMPT_LEARNINGS = 10;

function normalizeWhitespace(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function sanitizeLesson(value) {
    return normalizeWhitespace(value);
}

function sanitizeContext(value) {
    return normalizeWhitespace(value) || 'general';
}

function sanitizeCreatedAt(value) {
    const parsed = new Date(value ?? '');
    if (Number.isNaN(parsed.getTime())) {
        return new Date().toISOString();
    }

    return parsed.toISOString();
}

function sanitizeUseCount(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return 1;
    }

    return Math.floor(numeric);
}

function sanitizeLearning(raw, fallbackId) {
    return {
        id: String(raw?.id ?? '').trim() || fallbackId,
        lesson: sanitizeLesson(raw?.lesson),
        context: sanitizeContext(raw?.context),
        createdAt: sanitizeCreatedAt(raw?.createdAt),
        useCount: sanitizeUseCount(raw?.useCount),
    };
}

function normalizeMemory(memory) {
    const learnings = Array.isArray(memory?.learnings) ? memory.learnings : [];
    return {
        learnings: learnings
            .map((learning, index) => sanitizeLearning(learning, `${Date.now()}-${index + 1}`))
            .filter((learning) => learning.lesson.length > 0),
    };
}

function toMarkdown(memory) {
    const prioritized = [...memory.learnings].sort((a, b) => {
        if (b.useCount !== a.useCount) {
            return b.useCount - a.useCount;
        }

        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    const learnedRules = prioritized.length === 0
        ? '_No learnings saved yet._'
        : prioritized.map((learning, index) => {
            return [
                `### ${index + 1}. ${learning.lesson}`,
                `- \`id\`: ${learning.id}`,
                `- \`context\`: ${learning.context}`,
                `- \`first_seen\`: ${learning.createdAt}`,
                `- \`reinforced\`: ${learning.useCount}`,
                '',
            ].join('\n');
        }).join('\n').trimEnd();

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

function parseMarkdownMemory(markdown) {
    const learnings = [];
    const lines = String(markdown ?? '').split(/\r?\n/);
    let current = {};
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
        }
    }

    pushCurrent();
    return normalizeMemory({ learnings });
}

function ensureMemoryFile() {
    memoryStore.ensureScaffold();
    fs.mkdirSync(path.dirname(MEMORY_MARKDOWN_FILE), { recursive: true });
    if (!fs.existsSync(MEMORY_MARKDOWN_FILE)) {
        fs.writeFileSync(MEMORY_MARKDOWN_FILE, toMarkdown({ learnings: [] }), 'utf8');
    }
}

function loadMemory() {
    ensureMemoryFile();

    try {
        const markdown = fs.readFileSync(MEMORY_MARKDOWN_FILE, 'utf8');
        return normalizeMemory(parseMarkdownMemory(markdown));
    } catch {
        return { learnings: [] };
    }
}

function saveMemory(memory) {
    ensureMemoryFile();
    fs.writeFileSync(MEMORY_MARKDOWN_FILE, toMarkdown(normalizeMemory(memory)), 'utf8');
}

function areSimilarLessons(first, second) {
    const normalizedFirst = sanitizeLesson(first).toLowerCase();
    const normalizedSecond = sanitizeLesson(second).toLowerCase();
    if (!normalizedFirst || !normalizedSecond) {
        return false;
    }

    if (normalizedFirst === normalizedSecond) {
        return true;
    }

    const prefixLength = Math.min(40, normalizedFirst.length, normalizedSecond.length);
    if (prefixLength >= 20 && normalizedFirst.slice(0, prefixLength) === normalizedSecond.slice(0, prefixLength)) {
        return true;
    }

    return normalizedFirst.includes(normalizedSecond) || normalizedSecond.includes(normalizedFirst);
}

export function addLearning(lesson, context) {
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

    if (memory.learnings.length > MAX_LEARNINGS) {
        memory.learnings = [...memory.learnings]
            .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
            .slice(-MAX_LEARNINGS);
    }

    saveMemory(memory);
}

export function getLearnings() {
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

export function clearLearnings() {
    saveMemory({ learnings: [] });
}

export function initializeDefaultLearnings() {
    saveMemory(loadMemory());
}
