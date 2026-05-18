/**
 * Memory System v3 - Persistent reusable memory
 *
 * Stores only reusable knowledge:
 *   - Semantic: facts about sites/UIs ("ialoc.ro puts time slots in a dropdown")
 *   - Procedural: strategies/workarounds ("click inside modal before scrolling it")
 *
 * Storage: JSON on disk (memory.json) + markdown export for humans (MEMORY.local.md)
 * Retrieval: keyword tags + Jaccard similarity + priority decay (no vector DB needed)
 * Forgetting: importance-based invalidation, not FIFO deletion
 */

import fs from 'fs';
import path from 'path';
import { PRIVATE_STATE_DIR } from '@/lib/config';

const MEMORY_DIR = path.join(PRIVATE_STATE_DIR, 'browser-agent');
fs.mkdirSync(MEMORY_DIR, { recursive: true });

const MEMORY_JSON_FILE = path.join(MEMORY_DIR, 'memory.json');
const MEMORY_MD_FILE = path.join(MEMORY_DIR, 'MEMORY.local.md');
const MEMORY_VERSION = 3;

// ─── Limits ───────────────────────────────────────────────────────────────────
const MAX_PROMPT_DOMAIN_LEARNINGS = 5;
const MAX_PROMPT_GENERAL_LEARNINGS = 3;
const MAX_PROMPT_PROCEDURES = 3;
const MIN_LEARNING_WORDS = 5;
const MIN_LEARNING_LENGTH = 24;

// ─── Decay constants ──────────────────────────────────────────────────────────
const DECAY_LAMBDA = 0.03;          // ~23 day half-life
const WEIGHT_ACCESS_COUNT = 1.0;
const WEIGHT_REINFORCEMENT = 2.0;
const BASE_IMPORTANCE = 0.1;

// ─── Types ────────────────────────────────────────────────────────────────────

export type MemoryType = 'semantic' | 'procedural';
export type MemoryStatus = 'active' | 'invalidated';

export interface MemoryContext {
    domain: string;
    taskType?: string;
    tags: string[];
}

export interface TemporalMeta {
    createdAt: string;
    lastAccessedAt: string;
    accessCount: number;
    reinforcements: number;
}

export interface MemoryEntry {
    id: string;
    type: MemoryType;
    content: string;
    context: MemoryContext;
    temporal: TemporalMeta;
    importance: number;
    status: MemoryStatus;
    supersededBy?: string;
}

export interface MemoryStore {
    version: number;
    entries: MemoryEntry[];
}

// ─── Retrieval result ─────────────────────────────────────────────────────────

export interface RetrievedMemory {
    semantic: string[];
    procedural: string[];
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function generateId(): string {
    return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

function normalizeHost(value: string): string {
    return value.trim().toLowerCase().replace(/^www\./, '');
}

function extractDomain(value: string | undefined): string {
    if (!value) return 'general';
    const normalized = normalizeWhitespace(value);
    if (!normalized) return 'general';

    try {
        return normalizeHost(new URL(normalized).hostname) || 'general';
    } catch {
        try {
            return normalizeHost(new URL(`https://${normalized}`).hostname) || 'general';
        } catch {
            return normalizeHost(normalized) || 'general';
        }
    }
}

function daysSince(isoDate: string): number {
    const then = new Date(isoDate).getTime();
    const now = Date.now();
    return Math.max(0, (now - then) / (1000 * 60 * 60 * 24));
}

// ─── Importance scoring with temporal decay ───────────────────────────────────

function computeImportance(temporal: TemporalMeta): number {
    const accessScore = WEIGHT_ACCESS_COUNT * temporal.accessCount;
    const reinforceScore = WEIGHT_REINFORCEMENT * temporal.reinforcements;
    const age = daysSince(temporal.lastAccessedAt);
    const decay = Math.exp(-DECAY_LAMBDA * age);
    return (BASE_IMPORTANCE + accessScore + reinforceScore) * decay;
}

function refreshImportance(entry: MemoryEntry): MemoryEntry {
    return { ...entry, importance: computeImportance(entry.temporal) };
}

// ─── Keyword extraction & similarity ──────────────────────────────────────────

const STOP_WORDS = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
    'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'up',
    'about', 'into', 'through', 'during', 'before', 'after', 'above',
    'below', 'between', 'out', 'off', 'over', 'under', 'again', 'further',
    'then', 'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all',
    'both', 'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
    'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
    'just', 'because', 'as', 'until', 'while', 'if', 'or', 'and', 'but',
    'it', 'its', 'this', 'that', 'these', 'those', 'i', 'me', 'my', 'we',
    'our', 'you', 'your', 'he', 'him', 'his', 'she', 'her', 'they', 'them',
    'their', 'what', 'which', 'who', 'whom',
]);

export function extractKeywords(text: string): string[] {
    const words = text
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !STOP_WORDS.has(w));

    return [...new Set(words)];
}

function jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
    if (setA.size === 0 && setB.size === 0) return 0;
    let intersection = 0;
    for (const item of setA) {
        if (setB.has(item)) intersection++;
    }
    const union = setA.size + setB.size - intersection;
    return union > 0 ? intersection / union : 0;
}

function textSimilarity(a: string, b: string): number {
    const wordsA = new Set(extractKeywords(a));
    const wordsB = new Set(extractKeywords(b));
    return jaccardSimilarity(wordsA, wordsB);
}

function areSimilar(a: string, b: string): boolean {
    const cleanA = normalizeWhitespace(a).toLowerCase();
    const cleanB = normalizeWhitespace(b).toLowerCase();

    if (cleanA === cleanB) return true;

    // Prefix match (40 chars)
    const prefixLen = Math.min(40, cleanA.length, cleanB.length);
    if (prefixLen >= 20 && cleanA.slice(0, prefixLen) === cleanB.slice(0, prefixLen)) return true;

    // Substring containment
    if (cleanA.includes(cleanB) || cleanB.includes(cleanA)) return true;

    // Jaccard similarity > 0.6
    if (textSimilarity(a, b) > 0.6) return true;

    return false;
}

// ─── Relevance scoring for retrieval ──────────────────────────────────────────

interface RelevanceScore {
    entry: MemoryEntry;
    score: number;
}

function scoreRelevance(
    entry: MemoryEntry,
    queryDomain: string,
    queryKeywords: Set<string>,
    queryGoal?: string
): number {
    if (entry.status === 'invalidated') return -1;

    let score = 0;
    let hasContextMatch = false;

    // Domain match: strong signal
    if (entry.context.domain !== 'general' && entry.context.domain === queryDomain) {
        score += 3.0;
        hasContextMatch = true;
    }

    // Tag overlap with query keywords
    const entryTags = new Set(entry.context.tags);
    const tagOverlap = jaccardSimilarity(entryTags, queryKeywords);
    if (tagOverlap > 0.15) {
        score += tagOverlap * 2.0;
        hasContextMatch = true;
    }

    // Content similarity with goal
    if (queryGoal) {
        const contentSim = textSimilarity(entry.content, queryGoal);
        if (contentSim > 0.15) {
            score += contentSim * 1.5;
            hasContextMatch = true;
        }
    }

    // General-domain entries with high reinforcement are always somewhat relevant
    if (entry.context.domain === 'general' && entry.temporal.reinforcements >= 2) {
        hasContextMatch = true;
        score += 1.0;
    }

    // No context match at all = irrelevant, regardless of importance
    if (!hasContextMatch) return 0;

    // Importance bonus (includes temporal decay) - small multiplier
    score += Math.min(entry.importance * 0.3, 1.5);

    return score;
}

// ─── Persistence ──────────────────────────────────────────────────────────────

function createEmptyStore(): MemoryStore {
    return { version: MEMORY_VERSION, entries: [] };
}

function normalizeEntries(rawEntries: unknown): MemoryEntry[] {
    if (!Array.isArray(rawEntries)) return [];

    return rawEntries
        .filter((entry): entry is MemoryEntry =>
            Boolean(entry) &&
            typeof entry === 'object' &&
            'type' in entry &&
            ((entry as MemoryEntry).type === 'semantic' || (entry as MemoryEntry).type === 'procedural')
        )
        .map(refreshImportance);
}

function loadStore(): MemoryStore {
    if (fs.existsSync(MEMORY_JSON_FILE)) {
        try {
            const raw = JSON.parse(fs.readFileSync(MEMORY_JSON_FILE, 'utf8'));
            if ((raw.version === 2 || raw.version === MEMORY_VERSION) && Array.isArray(raw.entries)) {
                return {
                    version: MEMORY_VERSION,
                    entries: normalizeEntries(raw.entries),
                };
            }
        } catch {
            console.log('⚠️ Could not parse memory.json, starting fresh');
        }
    }

    return createEmptyStore();
}

function saveStore(store: MemoryStore): void {
    try {
        fs.writeFileSync(MEMORY_JSON_FILE, JSON.stringify(store, null, 2), 'utf8');
        exportToMarkdown(store);
    } catch {
        console.log('⚠️ Could not save memory');
    }
}

// ─── Markdown export (human-readable view) ────────────────────────────────────

function exportToMarkdown(store: MemoryStore): void {
    const active = store.entries.filter(e => e.status === 'active');
    const semantic = active.filter(e => e.type === 'semantic').sort((a, b) => b.importance - a.importance);
    const procedural = active.filter(e => e.type === 'procedural').sort((a, b) => b.importance - a.importance);

    let md = `# Browser Agent Memory v3\n\n`;
    md += `> Auto-generated from memory.json. Edit memory.json directly for changes.\n\n`;
    md += `**Total entries:** ${active.length} active | ${store.entries.length - active.length} invalidated\n`;
    md += `**Stored types:** semantic, procedural\n\n`;

    // Semantic memories
    md += `## Semantic Memory (Facts)\n\n`;
    if (semantic.length === 0) {
        md += `_No facts stored yet._\n\n`;
    } else {
        for (const entry of semantic) {
            md += `### ${entry.content}\n`;
            md += `- **domain:** ${entry.context.domain}`;
            if (entry.context.taskType) md += ` | **task:** ${entry.context.taskType}`;
            md += `\n`;
            md += `- **tags:** ${entry.context.tags.join(', ') || 'none'}\n`;
            md += `- **importance:** ${entry.importance.toFixed(2)} | **accessed:** ${entry.temporal.accessCount}x | **reinforced:** ${entry.temporal.reinforcements}x\n`;
            md += `- **created:** ${entry.temporal.createdAt.slice(0, 10)} | **last used:** ${entry.temporal.lastAccessedAt.slice(0, 10)}\n\n`;
        }
    }

    // Procedural memories
    md += `## Procedural Memory (Strategies)\n\n`;
    if (procedural.length === 0) {
        md += `_No strategies stored yet._\n\n`;
    } else {
        for (const entry of procedural) {
            md += `### ${entry.content}\n`;
            md += `- **domain:** ${entry.context.domain}`;
            if (entry.context.taskType) md += ` | **task:** ${entry.context.taskType}`;
            md += `\n`;
            md += `- **tags:** ${entry.context.tags.join(', ') || 'none'}\n`;
            md += `- **importance:** ${entry.importance.toFixed(2)} | **accessed:** ${entry.temporal.accessCount}x | **reinforced:** ${entry.temporal.reinforcements}x\n\n`;
        }
    }

    try {
        fs.writeFileSync(MEMORY_MD_FILE, md, 'utf8');
    } catch {
        // Non-critical
    }
}

// ─── Heuristic: is this a procedure/strategy? ─────────────────────────────────

const PROCEDURAL_SIGNALS = [
    /\bif\b.+\bthen\b/i,
    /\bwhen\b.+\b(use|try|do|click|type|scroll|wait)\b/i,
    /\balways\b/i,
    /\bnever\b/i,
    /\bfirst\b.+\bthen\b/i,
    /\bbefore\b.+\b(do|click|type|submit)\b/i,
    /\bafter\b.+\b(do|click|type|submit)\b/i,
    /\bstrategy\b/i,
    /\bapproach\b/i,
    /\binstead\b/i,
    /\brather\b/i,
    /\bneed(s)?\s+to\b/i,
];

function isProceduralContent(text: string): boolean {
    return PROCEDURAL_SIGNALS.some(pattern => pattern.test(text));
}

// ─── Quality check ────────────────────────────────────────────────────────────

function isHighSignal(lesson: string): boolean {
    const cleaned = normalizeWhitespace(lesson);
    if (!cleaned || cleaned.length < MIN_LEARNING_LENGTH) return false;
    if (cleaned.split(/\s+/).length < MIN_LEARNING_WORDS) return false;
    return true;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Add a semantic or procedural learning.
 * Automatically classifies as procedural if it contains strategy-like patterns.
 * Deduplicates using Jaccard similarity + prefix matching.
 */
export function addLearning(lesson: string, context: string, taskType?: string): boolean {
    const cleaned = normalizeWhitespace(lesson);
    if (!cleaned || !isHighSignal(cleaned)) return false;

    const store = loadStore();
    const domain = extractDomain(context);
    const tags = extractKeywords(cleaned);
    const memType: MemoryType = isProceduralContent(cleaned) ? 'procedural' : 'semantic';
    const now = new Date().toISOString();

    // Check for similar existing entry on the same domain first.
    // Allow promoting a general rule to a site-specific one, but do not merge across unrelated domains.
    const existing = store.entries.find(e =>
        e.status === 'active' &&
        e.context.domain === domain &&
        areSimilar(e.content, cleaned)
    ) || (
        domain !== 'general'
            ? store.entries.find(e =>
                e.status === 'active' &&
                e.context.domain === 'general' &&
                areSimilar(e.content, cleaned)
            )
            : undefined
    );

    if (existing) {
        // Reinforce existing memory
        existing.temporal.accessCount++;
        existing.temporal.reinforcements++;
        existing.temporal.lastAccessedAt = now;
        existing.importance = computeImportance(existing.temporal);

        // Upgrade domain if current is more specific
        if (existing.context.domain === 'general' && domain !== 'general') {
            existing.context.domain = domain;
        }

        // Merge new tags
        const existingTagSet = new Set(existing.context.tags);
        for (const tag of tags) {
            existingTagSet.add(tag);
        }
        existing.context.tags = [...existingTagSet];

        // Add taskType if provided
        if (taskType && !existing.context.taskType) {
            existing.context.taskType = taskType;
        }

        saveStore(store);
        return true;
    }

    // Check if this supersedes an older, less precise version
    let supersededId: string | undefined;
    const fuzzyMatch = store.entries.find(e =>
        e.status === 'active' &&
        e.context.domain === domain &&
        textSimilarity(e.content, cleaned) > 0.4
    );
    if (fuzzyMatch && cleaned.length > fuzzyMatch.content.length) {
        // New version is longer/more detailed - supersede old one
        fuzzyMatch.status = 'invalidated';
        supersededId = fuzzyMatch.id;
    }

    const newEntry: MemoryEntry = {
        id: generateId(),
        type: memType,
        content: cleaned,
        context: { domain, taskType, tags },
        temporal: {
            createdAt: now,
            lastAccessedAt: now,
            accessCount: 1,
            reinforcements: 0,
        },
        importance: computeImportance({
            createdAt: now,
            lastAccessedAt: now,
            accessCount: 1,
            reinforcements: 0,
        }),
        status: 'active',
        supersededBy: undefined,
    };

    if (supersededId) {
        const old = store.entries.find(e => e.id === supersededId);
        if (old) old.supersededBy = newEntry.id;
    }

    store.entries.push(newEntry);
    saveStore(store);

    console.log(`💡 ${memType === 'procedural' ? '🧩 Procedure' : '📝 Fact'}: ${cleaned}`);
    return true;
}

/**
 * Retrieve relevant memories for the current context.
 * Returns semantic facts and procedural strategies.
 */
export function getMemories(url?: string, goal?: string): RetrievedMemory {
    const store = loadStore();
    const domain = extractDomain(url);
    const goalKeywords = new Set(extractKeywords(goal || ''));

    // Score and rank all active entries
    const scored: RelevanceScore[] = store.entries
        .filter(e => e.status === 'active')
        .map(entry => ({
            entry,
            score: scoreRelevance(entry, domain, goalKeywords, goal),
        }))
        .filter(s => s.score > 1.0) // Minimum relevance threshold - must have domain match OR strong keyword overlap
        .sort((a, b) => b.score - a.score);

    // Split into semantic and procedural
    const semanticResults = scored
        .filter(s => s.entry.type === 'semantic')
        .slice(0, MAX_PROMPT_DOMAIN_LEARNINGS + MAX_PROMPT_GENERAL_LEARNINGS);

    const proceduralResults = scored
        .filter(s => s.entry.type === 'procedural')
        .slice(0, MAX_PROMPT_PROCEDURES);

    return {
        semantic: semanticResults.map(s => s.entry.content),
        procedural: proceduralResults.map(s => s.entry.content),
    };
}

/**
 * Clear all memory.
 */
export function clearLearnings(): void {
    saveStore(createEmptyStore());
}

/**
 * Initialize memory file if it doesn't exist.
 */
export function initializeDefaultLearnings(): void {
    if (!fs.existsSync(MEMORY_JSON_FILE)) {
        saveStore(createEmptyStore());
        return;
    }

    saveStore(loadStore());
}

/**
 * Invalidate a specific memory by ID (Zep-style: don't delete, mark invalid).
 */
export function invalidateMemory(id: string, supersededById?: string): boolean {
    const store = loadStore();
    const entry = store.entries.find(e => e.id === id);
    if (!entry) return false;

    entry.status = 'invalidated';
    if (supersededById) entry.supersededBy = supersededById;
    saveStore(store);
    return true;
}

/**
 * Get memory stats for debugging/status display.
 */
export function getMemoryStats(): {
    totalEntries: number;
    active: number;
    invalidated: number;
    semantic: number;
    procedural: number;
    topDomains: { domain: string; count: number }[];
} {
    const store = loadStore();
    const allEntries = [...store.entries];
    const active = allEntries.filter(e => e.status === 'active');
    const invalidated = allEntries.filter(e => e.status === 'invalidated');

    const domainCounts = new Map<string, number>();
    for (const entry of active) {
        const d = entry.context.domain;
        domainCounts.set(d, (domainCounts.get(d) || 0) + 1);
    }

    const topDomains = [...domainCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([domain, count]) => ({ domain, count }));

    return {
        totalEntries: allEntries.length,
        active: active.length,
        invalidated: invalidated.length,
        semantic: store.entries.filter(e => e.type === 'semantic' && e.status === 'active').length,
        procedural: store.entries.filter(e => e.type === 'procedural' && e.status === 'active').length,
        topDomains,
    };
}
